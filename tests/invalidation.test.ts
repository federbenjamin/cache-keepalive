import { expect, test } from 'claude-code/testing'
import { accountChangedText, bumpText, LEAD_MS, TICK_MS } from '../hooks/register'
import { HOUR, mainTurn, typed, world } from './world'

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

test('an interrupted bump does not count cold or submit the same request twice', async ($, on) => {
  const { clock, submitted, statuses, step } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
  await clock.advance(HOUR - LEAD_MS)
  step.stopReason = null
  await abortWithoutResponse($, 'b1')
  await clock.advance(TICK_MS)
  expect(statuses).not.toContain('keepalive: cache was cold, rebuilt; pings go on')
  expect(submitted).toEqual([bumpText(1, 12)])
  await $.prompt.submit(typed('back'))
  await mainTurn($, 't2')
  await clock.advance(HOUR - LEAD_MS)
  expect(statuses.at(-1)).toBe('keepalive 1/12')
})

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
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't1')
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
