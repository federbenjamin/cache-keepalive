import type { EngineInterface, Register } from 'claude-code'
import type { KeepaliveTiming } from '../types'

// Keeps the main conversation's prompt cache warm while the session sits open and idle: a short
// prompt LEAD_MS before the cache would expire. The cache lifetime runs from the start of the
// main thread's last request, and each request resets it. Bumps stop at the model's cap; the
// last one asks for a handoff while the cache is still warm. The person's own next prompt
// resets the count. A bump that finds the cache already cold has just rebuilt it, so the bumps
// go on; COLD_LIMIT cold bumps in a row (the TTL dropped to 5m past plan usage, so every bump
// lands after expiry) stop them until the person is back. So does a change of
// account (`claude auth status`, polled each tick while the cache may be warm): the prompt cache is the
// account's own, so the next request under another account rebuilds it whole. `/keepalive off`
// stops them for the conversation, a typed prompt included, until `/keepalive on`.
//
// Every bump is submitted asUser, so the model reads the bare text without the engine's
// "The cache-keepalive plugin sent a message" frame. A bump is still not a rewind point: the
// rewind list holds the person's own prompts, and asUser keeps the plugin origin.
//
// Caps sit below each model's break-even (pings that cost as much as one cold rebuild):
// Sonnet 5.5 19, Opus 5.5 39, Fable 5.1 79.

export const CAPS: ReadonlyArray<readonly [string, number]> = [
  ['fable', 12],
  ['opus', 12],
  ['sonnet', 6],
  ['haiku', 6],
]
const DEFAULT_CAP = 6
export const LEAD_MS = 2 * 60_000
export const HEADROOM_MS = 15_000 // the latest a bump may go: request latency before expiry
export const TICK_MS = 30_000
export const COLD_LIMIT = 2
export const COMMAND = 'keepalive'
const TIMING = { plugin: 'cache-keepalive', key: 'timing' } as const
export const AUTH_STATUS = ['claude', 'auth', 'status', '--json'] as const
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'slack-ping'])

export function capFor(model: string): number {
  const m = model.toLowerCase()
  return CAPS.find(([family]) => m.includes(family))?.[1] ?? DEFAULT_CAP
}

export function bumpText(n: number, cap: number): string {
  return n < cap
    ? 'keepalive ping. Reply only: ok'
    : 'Last keepalive ping: the prompt cache expires after this. ' +
        'Call the Skill tool with skill `handoff` now, so a fresh session can pick up from its document. Do nothing else.'
}

// `/keepalive off|on`: the off flag after the args, and the line the command prints.
export function keepaliveCommand(args: string, isOff: boolean): { isOff: boolean; text: string } {
  const arg = args.trim().toLowerCase()
  if (arg === 'off') return { isOff: true, text: 'keepalive off: no pings in this conversation until /keepalive on' }
  if (arg === 'on') return { isOff: false, text: 'keepalive on: pings resume from your next request' }
  return { isOff, text: `keepalive is ${isOff ? 'off' : 'on'}; /keepalive off or /keepalive on` }
}

// Whether a bump is due: idle, not stopped or off, and the last main request's cache inside the
// window from LEAD_MS to HEADROOM_MS before it expires (past that the bump would rebuild a cold
// cache), with no bump sent yet for that request (a bump's own request moves lastSend on).
export function isDue(s: Pick<KeepaliveTiming, 'lastSend' | 'bumpedFor' | 'isStopped' | 'isOff'> & { now: number; ttl: number; isBusy: boolean }): boolean {
  const expiresAt = s.lastSend + s.ttl
  return (
    !s.isBusy &&
    !s.isStopped &&
    !s.isOff &&
    s.lastSend > 0 &&
    s.bumpedFor !== s.lastSend &&
    s.now >= expiresAt - LEAD_MS &&
    s.now < expiresAt - HEADROOM_MS
  )
}

// A bump that wrote more of the prompt to the cache than it read found the cache cold.
export function wasCold(usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number }): boolean {
  return usage.cache_read_input_tokens < usage.cache_creation_input_tokens
}

// Whether the account the session would send under now is another than the one the cache was
// written under. An unknown account on either side (logged out, a failed read) is no change.
export function isAccountChanged(cachedUnder: string, current: string): boolean {
  return cachedUnder !== '' && current !== '' && cachedUnder !== current
}

export function accountChangedText(from: string, to: string): string {
  return `keepalive: account changed (${from} → ${to}), cache cold; stopped until your next prompt`
}

const fresh = (): KeepaliveTiming => ({ lastSend: 0, bumpedFor: 0, bumps: 0, coldBumps: 0, model: '', account: '', isStopped: false, isOff: false })

// The logged-in account's email from `claude auth status --json`; '' when logged out or unreadable.
export function accountOf(authStatus: string): string {
  try {
    const status = JSON.parse(authStatus) as { loggedIn?: unknown; email?: unknown }
    return status.loggedIn === true && typeof status.email === 'string' ? status.email : ''
  } catch {
    return ''
  }
}

// The account this session sends under; '' when that cannot be read.
async function currentAccount($: EngineInterface): Promise<string> {
  try {
    const { exitCode, stdout } = await $.process.run(AUTH_STATUS, { timeoutMs: 5_000 })
    return exitCode === 0 ? accountOf(stdout) : ''
  } catch {
    return ''
  }
}

export const register: Register = on => {
  // The timing lives here for synchronous checks and is written through to $.state, which
  // keeps it across a hot reload; session.start reads it back.
  let t = fresh()
  let isBusy = false
  let isBumpPending = false // a bump was submitted and its turn has not started
  let isBumpTurn = false // the running main turn is a bump
  let tick: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    tick?.cancel()
    tick = undefined
    if (e.isInteractive) {
      const { value } = await $.state.get(TIMING)
      if (value) t = { ...fresh(), ...value }
      $.ui.status(t.isOff ? 'keepalive off' : undefined)
      // Claude Code's main-conversation TTL: 1h on a subscription within plan usage, 5m when
      // set so. Past plan usage it drops to 5m on its own; the first bump then finds the cache
      // cold and stops the rest (turn.complete below).
      const force = await $.env.get('FORCE_PROMPT_CACHING_5M')
      const is5m = force === '1' || force === 'true' || (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')) === '5m'
      const ttl = (is5m ? 5 : 60) * 60_000

      tick = $.clock.every(TICK_MS, async () => {
        const now = await $.clock.now()
        // Polled only while a bump could still come: idle, not stopped or off, cache not expired.
        if (!isBusy && !t.isStopped && !t.isOff && t.lastSend > 0 && now < t.lastSend + ttl) {
          const account = await currentAccount($)
          if (isAccountChanged(t.account, account)) {
            t.isStopped = true
            $.ui.status(accountChangedText(t.account, account))
            await $.state.set(TIMING, { ...t })
            return
          }
        }
        if (!isDue({ ...t, now, ttl, isBusy })) return
        t.bumpedFor = t.lastSend
        const cap = capFor(t.model)
        if (t.bumps >= cap) {
          $.ui.status(`keepalive: done (${cap}/${cap}), cache left to expire`)
          await $.state.set(TIMING, { ...t })
          return
        }
        t.bumps++
        isBumpPending = true
        $.ui.status(`keepalive ${t.bumps}/${cap}`)
        try {
          await $.prompt.submit({ text: bumpText(t.bumps, cap), asUser: true })
        } catch {
          isBumpPending = false
          $.ui.status('keepalive: submit failed')
        }
        await $.state.set(TIMING, { ...t })
      })
      // After the timer, so a refused registration costs the command, not the bumps.
      await $.command.register({
        name: COMMAND,
        description: 'Stop or resume the prompt-cache keepalive pings for this conversation',
        argumentHint: '[off|on]',
        immediate: true,
      })
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const { isOff, text } = keepaliveCommand(e.args, t.isOff)
    t.isOff = isOff
    $.ui.status(isOff ? 'keepalive off' : undefined)
    await $.state.set(TIMING, { ...t })
    return { text }
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.has(e.origin.kind)) {
      t.bumps = 0
      t.coldBumps = 0
      t.isStopped = false
      isBumpPending = false
      $.ui.status(t.isOff ? 'keepalive off' : undefined)
      await $.state.set(TIMING, { ...t })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isBusy = true
    isBumpTurn = isBumpPending
    isBumpPending = false
    // Any main turn that is not a bump is the person's: the bump count leaves the status line.
    if (!isBumpTurn) $.ui.status(t.isOff ? 'keepalive off' : undefined)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      t.lastSend = await $.clock.now()
      t.model = e.model
      t.account = await currentAccount($)
      await $.state.set(TIMING, { ...t })
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      isBusy = false
      if (isBumpTurn && e.usage) {
        t.coldBumps = wasCold(e.usage) ? t.coldBumps + 1 : 0
        if (t.coldBumps >= COLD_LIMIT) {
          t.isStopped = true
          $.ui.status(`keepalive: cache cold ${COLD_LIMIT} pings in a row, stopped until your next prompt`)
        } else if (t.coldBumps > 0) {
          $.ui.status('keepalive: cache was cold, rebuilt; pings go on')
        }
        await $.state.set(TIMING, { ...t })
      }
      isBumpTurn = false
    }
    return next(e)
  })

  // /clear and an in-session resume end this conversation without a session.start for the next,
  // so its timing must not carry over.
  on('session.end', async ($, e, next) => {
    t = fresh()
    isBusy = false
    isBumpPending = false
    isBumpTurn = false
    $.ui.status(undefined)
    await $.state.set(TIMING, { ...t })
    return next(e)
  })
}
