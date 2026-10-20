import { expect, test } from 'claude-code/testing'
import { accountOf, bumpText, capFor, COLD_LIMIT, followsFirstRequest, HEADROOM_MS, isAccountChanged, isConversationReplaced, isDue, keepaliveCommand, LEAD_MS, TICK_MS, wasCold } from '../hooks/register'
import { COLD, HOUR, mainTurn, run, SUMMARY, T0, typed, WARM, world } from './world'

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

test('only the last bump asks for a handoff', async () => {
  expect(bumpText(5, 6)).toBe('keepalive ping. Reply only: ok')
  expect(bumpText(5, 6)).not.toContain('handoff')
  expect(bumpText(6, 6)).toContain('run a session-closing skill with the Skill tool')
  expect(bumpText(6, 6)).toContain('else a handoff skill, else write a handoff yourself')
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

test("only the main conversation's installed compaction replaces it, and only the first request's bump is exempt", async () => {
  expect(isConversationReplaced({ trigger: 'auto' }, {})).toBe(true)
  expect(isConversationReplaced({ trigger: 'manual' }, {})).toBe(true)
  expect(isConversationReplaced({ trigger: 'precompute' }, {})).toBe(false)
  expect(isConversationReplaced({ trigger: 'auto', agentId: 'a1' }, {})).toBe(false)
  expect(isConversationReplaced({ trigger: 'auto' }, { skip: 'blocked' })).toBe(false)
  expect(followsFirstRequest({ firstSend: T0, bumpedFor: T0 })).toBe(true)
  expect(followsFirstRequest({ firstSend: T0, bumpedFor: T0 + 1 })).toBe(false)
  expect(followsFirstRequest({ firstSend: 0, bumpedFor: 0 })).toBe(false)
})

test('only a known account that differs is a change', async () => {
  expect(isAccountChanged('a', 'b')).toBe(true)
  expect(isAccountChanged('a', 'a')).toBe(false)
  expect(isAccountChanged('', 'b')).toBe(false)
  expect(isAccountChanged('a', '')).toBe(false)
})

test('the account is the email of a logged-in auth status, empty when logged out, unread otherwise', async () => {
  expect(accountOf('{"loggedIn":true,"email":"a@x.com","orgId":"o1"}')).toBe('a@x.com')
  expect(accountOf('{"loggedIn":false}')).toBe('')
  expect(accountOf('{"loggedIn":true}')).toBe(undefined)
  expect(accountOf('{"loggedIn":true,"email":""}')).toBe(undefined)
  expect(accountOf('{"email":"a@x.com"}')).toBe(undefined)
  expect(accountOf('{}')).toBe(undefined)
  expect(accountOf('null')).toBe(undefined)
  expect(accountOf('{"loggedIn":tr')).toBe(undefined)
  expect(accountOf('not json')).toBe(undefined)
  expect(accountOf('')).toBe(undefined)
})

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

test('one cold bump rebuilt the cache, so the bumps go on', async ($, on) => {
  const { clock, submitted } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't0')
  await clock.advance(TICK_MS)
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
  await mainTurn($, 't0')
  await clock.advance(TICK_MS)
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

test("a compaction leaves nothing to keep warm, and the bump after the new conversation's first request is not counted cold", async ($, on) => {
  const { clock, submitted } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await mainTurn($, 't0')
  await clock.advance(TICK_MS)
  await mainTurn($, 't1')
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toEqual([bumpText(1, 12)]) // a precompute installs nothing: the old cache is still the one to keep warm
  await mainTurn($, 'b1', WARM)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  await clock.advance(2 * HOUR)
  expect(submitted).toHaveLength(1) // the compacted conversation is in no cache yet
  await mainTurn($, 't2')
  for (let n = 2; n <= COLD_LIMIT + 1; n++) {
    await clock.advance(HOUR - LEAD_MS)
    await mainTurn($, `b${n}`, COLD)
  }
  await clock.advance(HOUR - LEAD_MS)
  expect(submitted).toHaveLength(COLD_LIMIT + 2) // the first cold bump answered t2, the first request, so it did not count
})
