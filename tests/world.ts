import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk, TurnStopReason } from 'claude-code'
import { AUTH_STATUS, COMMAND } from '../hooks/register'

export const HOUR = 60 * 60_000
export const T0 = 1_000_000
export const COLD = { cache_read_input_tokens: 0, cache_creation_input_tokens: 163_000 }
export const WARM = { cache_read_input_tokens: 163_000, cache_creation_input_tokens: 20 }

export async function mainTurn($: Engine, turnId: string, usage?: { cache_read_input_tokens: number; cache_creation_input_tokens: number }) {
  await $.turn.start({ text: 'hi', turnId })
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // drain
  }
  const turnUsage = usage && { input_tokens: 2, output_tokens: 1, model: 'claude-opus-5-5', ...usage }
  await $.turn.complete({ turnId, reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, usage: turnUsage })
}

export const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
export const run = (args: string) => ({ command: COMMAND, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })

export function world(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, {})
  const acct = { name: 'acct1', loggedIn: true, runs: 0, holdMs: 0 }
  on('process.run', async (_$, e) => {
    if (e.argv.join('\u0000') !== AUTH_STATUS.join('\u0000')) throw new Error('unexpected process command')
    acct.runs++
    const holdMs = acct.holdMs
    acct.holdMs = 0
    if (holdMs > 0) await clock.sleep(holdMs)
    const readable = acct.name !== ''
    const stdout = readable ? JSON.stringify(acct.loggedIn ? { loggedIn: true, email: acct.name } : { loggedIn: false }) : ''
    return { value: { exitCode: readable ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const submitted: string[] = []
  const asUser: boolean[] = []
  const statuses: (string | undefined)[] = []
  const step: { chunks: TurnStepChunk[]; stopReason: TurnStopReason; runs: number } = { chunks: [], stopReason: 'end_turn', runs: 0 }
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
    step.runs++
    const chunks = step.chunks
    const stopReason = step.stopReason
    step.chunks = []
    step.stopReason = 'end_turn'
    for (const chunk of chunks) yield chunk
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason, usage: null }
  })
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  return { clock, submitted, asUser, statuses, acct, step }
}
