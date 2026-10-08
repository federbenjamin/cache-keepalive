import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { accountChangedText, accountOf, AUTH_STATUS, bumpText, capFor, COLD_LIMIT, COMMAND, HEADROOM_MS, isAccountChanged, isDue, keepaliveCommand, LEAD_MS, TICK_MS, wasCold } from '../hooks/register'

const HOUR = 60 * 60_000
const T0 = 1_000_000
const base = { lastSend: T0, bumpedFor: 0, isStopped: false, isOff: false, ttl: HOUR, isBusy: false }

test('a bump is due from LEAD_MS to HEADROOM_MS before expiry, and never after', async () => {
  expect(isDue({ ...base, now: T0 + HOUR - LEAD_MS - 1 })).toBe(false)
  expect(isDue({ ...base, now: T0 + HOUR - LEAD_MS })).toBe(true)
  expect(isDue({ ...base, now: T0 + HOUR - HEADROOM_MS - 1 })).toBe(true)
  expect(isDue({ ...base, now: T0 + HOUR - HEADROOM_MS })).toBe(false)
  expect(isDue({ ...base, now: T0 + 2 * HOUR })).toBe(false)
})

test('no bump while a turn runs, before any request, twice for one request, or once stopped', async () => {
  const now = T0 + HOUR - LEAD_MS
  expect(isDue({ ...base, now, isBusy: true })).toBe(false)
  expect(isDue({ ...base, now, lastSend: 0 })).toBe(false)
  expect(isDue({ ...base, now, bumpedFor: T0 })).toBe(false)
  expect(isDue({ ...base, now, isStopped: true })).toBe(false)
  expect(isDue({ ...base, now, isOff: true })).toBe(false)
})

test('caps by model family, defaulting to the smallest', async () => {
  expect(capFor('claude-opus-5-5')).toBe(12)
  expect(capFor('claude-fable-5-1')).toBe(12)
  expect(capFor('claude-sonnet-5-5')).toBe(6)
  expect(capFor('claude-haiku-4-5-20251001')).toBe(6)
  expect(capFor('')).toBe(6)
})

test('only the last bump asks for the handoff, naming the tool', async () => {
  expect(bumpText(5, 6)).toBe('keepalive ping. Reply only: ok')
  expect(bumpText(5, 6)).not.toContain('handoff')
  expect(bumpText(6, 6)).toContain('Call the Skill tool with skill `handoff`')
})

test('/keepalive takes off and on, and reports the state for anything else', async () => {
  expect(keepaliveCommand(' OFF ', false).isOff).toBe(true)
  expect(keepaliveCommand('on', true).isOff).toBe(false)
  expect(keepaliveCommand('', true)).toEqual({ isOff: true, text: 'keepalive is off; /keepalive off or /keepalive on' })
})

test('a bump that wrote more than it read found the cache cold', async () => {
  expect(wasCold({ cache_read_input_tokens: 73_000, cache_creation_input_tokens: 88 })).toBe(false)
  expect(wasCold({ cache_read_input_tokens: 31_000, cache_creation_input_tokens: 42_000 })).toBe(true)
})

test('only a known account that differs is a change', async () => {
  expect(isAccountChanged('a', 'b')).toBe(true)
  expect(isAccountChanged('a', 'a')).toBe(false)
  expect(isAccountChanged('', 'b')).toBe(false)
  expect(isAccountChanged('a', '')).toBe(false)
})

test('the account is the email of a logged-in auth status, else unknown', async () => {
  expect(accountOf('{"loggedIn":true,"email":"a@x.com","orgId":"o1"}')).toBe('a@x.com')
  expect(accountOf('{"loggedIn":false}')).toBe('')
  expect(accountOf('{"loggedIn":true}')).toBe('')
  expect(accountOf('not json')).toBe('')
})

// One main turn with one request, at the clock's current time.
async function mainTurn($: Engine, turnId: string, usage?: { cache_read_input_tokens: number; cache_creation_input_tokens: number }) {
  await $.turn.start({ text: 'hi', turnId })
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // drain
  }
  const turnUsage = usage && { input_tokens: 2, output_tokens: 1, model: 'claude-opus-5-5', ...usage }
  await $.turn.complete({ turnId, reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, usage: turnUsage })
}

const COLD = { cache_read_input_tokens: 0, cache_creation_input_tokens: 163_000 }
const WARM = { cache_read_input_tokens: 163_000, cache_creation_input_tokens: 20 }

// The engine beneath the plugin: a clock at T0, no env, a model that answers each request at
// once, a `claude auth status` logged in as `acct.name` (fails when it is ''), and a record of every
// prompt the plugin submits.
function world(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, {})
  const acct = { name: 'acct1', runs: 0 }
  on('process.run', async (_$, e) => {
    expect(e.argv).toEqual(AUTH_STATUS)
    acct.runs++
    const ok = acct.name !== ''
    const stdout = ok ? JSON.stringify({ loggedIn: true, email: acct.name }) : ''
    return { value: { exitCode: ok ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const submitted: string[] = []
  const asUser: boolean[] = []
  const statuses: (string | undefined)[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('prompt.submit', async (_$, e) => {
    if (e.origin.kind === 'plugin') {
      submitted.push(e.text)
      asUser.push(e.origin.asUser === true)
    }
    return { text: e.text }
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  return { clock, submitted, asUser, statuses, acct }
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const run = (args: string) => ({ command: COMMAND, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })

test('an idle session gets exactly one bump in the window, none after expiry', async ($, on) => {
  const { clock, submitted } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS - TICK_MS)
  expect(submitted).toEqual([])
  await clock.advance(TICK_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
  await clock.advance(HOUR) // the bump's turn never ran here, so its request never moved lastSend
  expect(submitted).toHaveLength(1)
})

test('a turn that ran past expiry does not bump the cold cache when it ends', async ($, on) => {
  const { clock, submitted } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  await clock.advance(HOUR + TICK_MS) // a permission prompt left waiting
  await $.turn.complete({ turnId: 't1', reason: 'aborted', answer: '', durationMs: HOUR, isAborted: true })
  await clock.advance(4 * TICK_MS)
  expect(submitted).toEqual([])
})

test('/clear drops the old conversation timing', async ($, on) => {
  const { clock, submitted } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(HOUR)
  expect(submitted).toEqual([])
})

test('a -p run never bumps', async ($, on) => {
  const { clock, submitted } = world(on)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await mainTurn($, 't1')
  await clock.advance(HOUR)
  expect(submitted).toEqual([])
})

test("bumps go in bare (asUser), and the person's next prompt takes the count off the status line", async ($, on) => {
  const { clock, submitted, asUser, statuses } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
  expect(asUser).toEqual([true])
  expect(statuses.at(-1)).toBe('keepalive 1/12')
  await $.prompt.submit(typed('back'))
  expect(statuses.at(-1)).toBe(undefined)
})

test('/keepalive off stops bumps through a typed prompt; /keepalive on brings them back', async ($, on) => {
  const { clock, submitted, statuses } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run(run('off'))
  expect(statuses.at(-1)).toBe('keepalive off')
  await $.prompt.submit(typed('one more thing'))
  await mainTurn($, 't1')
  expect(statuses.at(-1)).toBe('keepalive off')
  await clock.advance(HOUR)
  expect(submitted).toEqual([])
  await $.command.run(run('on'))
  expect(statuses.at(-1)).toBe(undefined)
  await mainTurn($, 't2')
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('an account switch stops the bumps within one tick, until the person is back', async ($, on) => {
  const { clock, submitted, statuses, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(10 * TICK_MS)
  acct.name = 'acct2'
  await clock.advance(TICK_MS)
  expect(statuses.at(-1)).toBe(accountChangedText('acct1', 'acct2'))
  await clock.advance(HOUR)
  expect(submitted).toEqual([])
  // The person's own prompt rebuilds the cache under acct2; bumps resume from there.
  await $.prompt.submit(typed('back'))
  await mainTurn($, 't2')
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('an account that cannot be read never stops the bumps', async ($, on) => {
  const { clock, submitted, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  acct.name = ''
  await clock.advance(HOUR - LEAD_MS)
  expect(acct.runs).toBeGreaterThan(1)
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('auth status is not polled once the cache has expired', async ($, on) => {
  const { clock, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(HOUR + TICK_MS)
  const runs = acct.runs
  expect(runs).toBeGreaterThan(1)
  await clock.advance(HOUR)
  expect(acct.runs).toBe(runs)
})

test('one cold bump rebuilt the cache, so the bumps go on', async ($, on) => {
  const { clock, submitted } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS)
  await mainTurn($, 'b1', COLD)
  await clock.advance(HOUR - LEAD_MS)
  await mainTurn($, 'b2', WARM)
  await clock.advance(HOUR - LEAD_MS)
  await mainTurn($, 'b3', COLD)
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toEqual([1, 2, 3, 4].map(n => bumpText(n, 12)))
})

test('COLD_LIMIT cold bumps in a row stop the bumps until the person is back', async ($, on) => {
  const { clock, submitted, statuses } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  for (let n = 1; n <= COLD_LIMIT; n++) {
    await clock.advance(HOUR - LEAD_MS)
    await mainTurn($, `b${n}`, COLD)
  }
  expect(statuses.at(-1)).toBe(`keepalive: cache cold ${COLD_LIMIT} pings in a row, stopped until your next prompt`)
  await clock.advance(HOUR)
  expect(submitted).toHaveLength(COLD_LIMIT)
  await $.prompt.submit(typed('back'))
  await mainTurn($, 't2')
  await clock.advance(HOUR - LEAD_MS)
  await mainTurn($, 'b3', COLD)
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toHaveLength(COLD_LIMIT + 2)
})
