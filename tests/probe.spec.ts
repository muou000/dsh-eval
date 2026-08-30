import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { readProbeMetrics, registerProbe } from '../src/probe.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('DSH session probe', () => {
  it('records content-free model, tool, outcome, and token accounting', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-probe-'))
    const output = join(root, 'probe.json')
    context = new Context()
    await context.plugin(SessionStore)
    const dispose = registerProbe(context, output, {
      DSH_EVAL_RUN_ID: 'run-1',
      DSH_EVAL_CASE_ID: 'case-1',
      DSH_EVAL_VARIANT: 'candidate',
    })
    const session = context.sessions.create(SessionId('probe-session'))
    const callId = 'call-1' as SessionEventMap['tool/call']['callId']
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'mock', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [], isError: true }),
      error: { name: 'Error', code: 'MOCK' },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await context.sessions.flush(session)
    dispose()

    expect(readProbeMetrics(output, { runId: 'run-1', caseId: 'case-1', variant: 'candidate' })).toMatchObject({
      source: 'dsh-eval-probe',
      trust: 'self-reported',
      sessions: 1,
      turns: 1,
      completedTurns: 1,
      modelCalls: 1,
      toolCalls: 1,
      toolErrors: 1,
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      totalTokens: 15,
    })
  })

  it('rejects a probe document replayed under another case identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-probe-'))
    const output = join(root, 'probe.json')
    context = new Context()
    await context.plugin(SessionStore)
    registerProbe(context, output, {
      DSH_EVAL_RUN_ID: 'run-1',
      DSH_EVAL_CASE_ID: 'case-1',
      DSH_EVAL_VARIANT: 'baseline',
    })
    expect(() => readProbeMetrics(output, { runId: 'run-1', caseId: 'case-2', variant: 'baseline' })).toThrow('identity')
  })
})
