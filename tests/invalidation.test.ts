import { expect, test } from 'claude-code/testing'
import { accountChangedText, bumpText, LEAD_MS, TICK_MS } from '../hooks/register'
import type { On } from 'claude-code'
import type { KeepaliveTiming } from '../types'
import { HOUR, mainTurn, SUMMARY, T0, typed, world } from './world'

const NO_RESPONSE = 'keepalive: ping got no response, cache left to expire'
const UNTIMED: KeepaliveTiming = { lastSend: 0, bumpedFor: 0, firstSend: 0, bumps: 0, coldBumps: 0, model: '', account: '', isStopped: false, isOff: false }

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) {
    // drain
  }
}

// The timing writes in the order they land; `hold.ms` holds the next write that long before it
// lands, and a hot reload's state.get reads the last to land.
function recordStore(on: On, clock: ReturnType<typeof world>['clock']) {
  const landed: KeepaliveTiming[] = []
  const hold = { ms: 0 }
  on('state.set', async (_$, e, next) => {
    const ms = hold.ms
    hold.ms = 0
    if (ms > 0) await clock.sleep(ms)
    const result = await next(e)
    landed.push(e.value as KeepaliveTiming)
    return result
  })
  on('state.get', async (_$, e, next) => {
    const value = landed.at(-1)
    return value ? { value: { value, version: landed.length } } : next(e)
  })
  return { landed, hold }
}

const mainStep = ($: Parameters<typeof mainTurn>[0], turnId: string) => $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })

async function abortWithoutResponse($: Parameters<typeof mainTurn>[0], turnId: string, reason: 'aborted' | 'error' = 'aborted') {
  await $.turn.start({ text: 'hi', turnId })
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // This response deliberately has no chunks.
  }
  await $.turn.complete({ turnId, reason, answer: '', durationMs: 1, isAborted: reason === 'aborted' })
}

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
  const { clock, submitted, statuses, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  acct.name = ''
  await clock.advance(HOUR - LEAD_MS)
  expect(acct.runs).toBeGreaterThan(1)
  expect(submitted).toEqual([bumpText(1, 12)])
  // An unreadable read on a later request keeps the account the cache was written under.
  acct.name = 'acct1'
  await $.prompt.submit(typed('back'))
  await mainTurn($, 't2')
  acct.name = ''
  await mainTurn($, 't3')
  acct.name = 'acct2'
  await clock.advance(TICK_MS)
  expect(statuses.at(-1)).toBe(accountChangedText('acct1', 'acct2'))
})

test('a refused account read on a request keeps the account the cache was written under', async ($, on) => {
  const { clock, statuses, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  acct.isNextRefused = true
  await mainTurn($, 't2')
  expect(acct.isNextRefused).toBe(false)
  acct.name = 'acct2'
  await clock.advance(TICK_MS)
  expect(statuses.at(-1)).toBe(accountChangedText('acct1', 'acct2'))
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

test('an interrupted request before its first response keeps the earlier bump window', async ($, on) => {
  const { clock, submitted, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(TICK_MS)
  step.stopReason = null
  await abortWithoutResponse($, 't2')
  await clock.advance(HOUR - LEAD_MS - TICK_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('an API error before any response keeps the earlier bump window', async ($, on) => {
  const { clock, submitted, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(TICK_MS)
  step.stopReason = null
  await abortWithoutResponse($, 't2', 'error')
  await clock.advance(HOUR - LEAD_MS - TICK_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('an interrupted response stream still moves the bump window to that request', async ($, on) => {
  const { clock, submitted, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(TICK_MS)
  step.chunks = [{ kind: 'text', index: 0, text: 'ok' }]
  step.stopReason = null
  await $.turn.start({ text: 'hi', turnId: 't2' })
  for await (const chunk of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    expect(chunk).toEqual({ kind: 'text', index: 0, text: 'ok' })
    break
  }
  await $.turn.complete({ turnId: 't2', reason: 'aborted', answer: '', durationMs: 1, isAborted: true })
  await clock.advance(HOUR - LEAD_MS - TICK_MS)
  expect(submitted).toEqual([])
  await clock.advance(TICK_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('an interrupted bump says the ping got no response, without counting cold or submitting the same request twice', async ($, on) => {
  const { clock, submitted, statuses, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS)
  step.stopReason = null
  await abortWithoutResponse($, 'b1')
  expect(statuses.at(-1)).toBe(NO_RESPONSE)
  await clock.advance(TICK_MS)
  expect(statuses).not.toContain('keepalive: cache was cold, rebuilt; pings go on')
  expect(submitted).toEqual([bumpText(1, 12)])
  await $.prompt.submit(typed('back'))
  await mainTurn($, 't2')
  await clock.advance(HOUR - LEAD_MS)
  expect(statuses.at(-1)).toBe('keepalive 1/12')
})

test('a bump that dies on an API error says the ping got no response', async ($, on) => {
  const { clock, submitted, statuses, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS)
  expect(statuses.at(-1)).toBe('keepalive 1/12')
  await $.turn.start({ text: bumpText(1, 12), turnId: 'b1' })
  step.error = new Error('overloaded')
  await expect(drain(mainStep($, 'b1'))).rejects.toThrow()
  await $.turn.complete({ turnId: 'b1', reason: 'error', answer: '', durationMs: 1, isAborted: false })
  expect(statuses.at(-1)).toBe(NO_RESPONSE)
  await clock.advance(LEAD_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('a bump interrupted mid-response was answered, so the next bump is timed from it', async ($, on) => {
  const { clock, submitted, statuses, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS)
  await $.turn.start({ text: bumpText(1, 12), turnId: 'b1' })
  step.chunks = [{ kind: 'text', index: 0, text: 'ok' }]
  step.stopReason = null
  for await (const _ of mainStep($, 'b1')) break
  await $.turn.complete({ turnId: 'b1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true })
  expect(statuses).not.toContain(NO_RESPONSE)
  expect(statuses.at(-1)).toBe('keepalive 1/12')
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toEqual([bumpText(1, 12), bumpText(2, 12)])
})

test('a bump answered before a compaction in its turn is not reported as unanswered', async ($, on) => {
  const { clock, statuses } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS)
  await $.turn.start({ text: bumpText(1, 12), turnId: 'b1' })
  await drain(mainStep($, 'b1'))
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  await $.turn.complete({ turnId: 'b1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true })
  expect(statuses).not.toContain(NO_RESPONSE)
})

test('an API error thrown before any response reaches the caller and keeps the earlier bump window', async ($, on) => {
  const { clock, submitted, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(TICK_MS)
  await $.turn.start({ text: 'hi', turnId: 't2' })
  step.error = new Error('overloaded')
  await expect(drain(mainStep($, 't2'))).rejects.toThrow()
  await $.turn.complete({ turnId: 't2', reason: 'error', answer: '', durationMs: 1, isAborted: false })
  await clock.advance(HOUR - LEAD_MS - TICK_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('an API error thrown before any response keeps the account the cache was written under', async ($, on) => {
  const { clock, statuses, step, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  acct.name = 'acct2'
  await $.turn.start({ text: 'hi', turnId: 't2' })
  step.error = new Error('overloaded')
  await expect(drain(mainStep($, 't2'))).rejects.toThrow()
  await $.turn.complete({ turnId: 't2', reason: 'error', answer: '', durationMs: 1, isAborted: false })
  await clock.advance(TICK_MS)
  expect(statuses.at(-1)).toBe(accountChangedText('acct1', 'acct2'))
})

test('an API error thrown after the response began reaches the caller and moves the bump window and account', async ($, on) => {
  const { clock, submitted, statuses, step, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(TICK_MS)
  acct.name = 'acct2'
  await $.turn.start({ text: 'hi', turnId: 't2' })
  step.chunks = [{ kind: 'text', index: 0, text: 'ok' }]
  step.error = new Error('connection reset')
  const chunks: unknown[] = []
  await expect(
    (async () => {
      for await (const chunk of mainStep($, 't2')) chunks.push(chunk)
    })(),
  ).rejects.toThrow()
  expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'ok' }])
  await $.turn.complete({ turnId: 't2', reason: 'error', answer: '', durationMs: 1, isAborted: false })
  await clock.advance(HOUR - LEAD_MS - TICK_MS)
  expect(submitted).toEqual([])
  await clock.advance(TICK_MS)
  expect(statuses).not.toContain(accountChangedText('acct1', 'acct2'))
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('a /clear during a request leaves the new conversation untimed', async ($, on) => {
  const { clock, submitted, step } = world(on)
  const { landed } = recordStore(on, clock)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  step.chunks = [{ kind: 'text', index: 0, text: 'o' }, { kind: 'text', index: 0, text: 'k' }]
  const stream = mainStep($, 't1')
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.next()
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await drain({ [Symbol.asyncIterator]: () => iterator })
  expect(landed.at(-1)).toEqual(UNTIMED)
  await clock.advance(HOUR)
  expect(submitted).toEqual([])
})

test('a compaction during a request leaves the compacted conversation untimed', async ($, on) => {
  const { clock, submitted, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  step.chunks = [{ kind: 'text', index: 0, text: 'o' }, { kind: 'text', index: 0, text: 'k' }]
  const stream = mainStep($, 't1')
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.next()
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  await drain({ [Symbol.asyncIterator]: () => iterator })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  await clock.advance(HOUR)
  expect(submitted).toEqual([])
})

test('a /clear while the account read is held stores nothing of the old request', async ($, on) => {
  const { clock, acct } = world(on)
  const { landed } = recordStore(on, clock)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  acct.holdMs = 5_000
  const done = drain(mainStep($, 't1'))
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(5_000)
  await done
  expect(landed.at(-1)).toEqual(UNTIMED)
})

test("a /clear while the request's timing write is held leaves the stored timing untimed", async ($, on) => {
  const { clock, submitted } = world(on)
  const { landed, hold } = recordStore(on, clock)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  hold.ms = 5_000
  const done = drain(mainStep($, 't1'))
  await clock.settle()
  const ended = $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.settle()
  await clock.advance(5_000)
  await ended
  await done
  expect(landed.at(-1)).toEqual(UNTIMED)
  // A hot reload reads back what landed last: nothing of the old conversation to bump for.
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(HOUR)
  expect(submitted).toEqual([])
})

test("an account stop whose write is held does not land over the person's later prompt", async ($, on) => {
  const { clock, submitted, statuses, acct } = world(on)
  const { landed, hold } = recordStore(on, clock)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  acct.name = 'acct2'
  hold.ms = 5_000
  await clock.advance(TICK_MS)
  expect(statuses.at(-1)).toBe(accountChangedText('acct1', 'acct2'))
  await $.prompt.submit(typed('back'))
  await clock.advance(5_000)
  expect(landed.at(-1)?.isStopped).toBe(false)
  // A hot reload before the person's request is answered reads back what landed last.
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't2')
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})

for (const [kind, stdout] of [
  ['cut-off JSON', '{"loggedIn":tr'],
  ['a logged-in answer with no email', '{"loggedIn":true}'],
] as const) {
  test(`an account read that exits 0 with ${kind} keeps the account the cache was written under`, async ($, on) => {
    const { clock, statuses, acct } = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await mainTurn($, 't1')
    acct.nextStdout = stdout
    await mainTurn($, 't2')
    expect(acct.nextStdout).toBe(undefined)
    acct.name = 'acct2'
    await clock.advance(TICK_MS)
    expect(statuses.at(-1)).toBe(accountChangedText('acct1', 'acct2'))
  })
}

test('a held account read does not hold the model request', async ($, on) => {
  const { clock, acct, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  acct.holdMs = 5_000
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  const iterator = stream[Symbol.asyncIterator]()
  const first = iterator.next()
  await clock.settle()
  expect(step.runs).toBe(1)
  await clock.advance(5_000)
  await first
  for await (const _ of iterator) {
    // drain
  }
})

test('a later request under a switched account becomes the account the cache uses', async ($, on) => {
  const { clock, submitted, statuses, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  acct.name = 'acct2'
  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 2 })) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  await clock.advance(HOUR - LEAD_MS)
  expect(statuses).not.toContain(accountChangedText('acct1', 'acct2'))
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('a hot reload keeps the account used by the cache', async ($, on) => {
  const { clock, statuses, acct } = world(on)
  // What the earlier load of the code left in $.state: a request answered at T0 under acct1.
  const stored: KeepaliveTiming = { lastSend: T0, bumpedFor: 0, firstSend: T0, bumps: 0, coldBumps: 0, model: 'claude-opus-5-5', account: 'acct1', isStopped: false, isOff: false }
  on('state.get', async () => ({ value: { value: stored, version: 1 } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  acct.name = 'acct2'
  await clock.advance(TICK_MS)
  expect(statuses.at(-1)).toBe(accountChangedText('acct1', 'acct2'))
})

test('a logged-out account read never stops the bumps', async ($, on) => {
  const { clock, submitted, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  acct.loggedIn = false
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('an account switch that reverses before the next tick leaves bumps running', async ($, on) => {
  const { clock, submitted, statuses, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  acct.name = 'acct2'
  acct.name = 'acct1'
  await clock.advance(HOUR - LEAD_MS)
  expect(statuses).not.toContain(accountChangedText('acct1', 'acct2'))
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('a stale account read cannot stop bumps after the person starts a new turn', async ($, on) => {
  const { clock, submitted, statuses, acct } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  acct.holdMs = 5_000
  await clock.advance(TICK_MS)
  acct.name = 'acct2'
  await $.prompt.submit(typed('back'))
  await $.turn.start({ text: 'back', turnId: 't2' })
  await clock.advance(5_000)
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
  await clock.advance(HOUR - LEAD_MS + TICK_MS)
  expect(statuses).not.toContain(accountChangedText('acct1', 'acct2'))
  expect(submitted).toEqual([bumpText(1, 12)])
})

test('a subagent turn while the main loop is idle does not hold the next bump', async ($, on) => {
  const { clock, submitted } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await $.turn.start({ text: 'work', turnId: 'a1', agentId: 'agent-1' })
  for await (const _ of $.turn.step({ turnId: 'a1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'agent-1' })) {
    // drain
  }
  await $.turn.complete({ turnId: 'a1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, agentId: 'agent-1' })
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toEqual([bumpText(1, 12)])
})
