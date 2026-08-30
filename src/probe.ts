import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { ProbeMetrics } from './types.ts'

interface MutableProbeMetrics {
  sessions: Set<string>
  turns: number
  completedTurns: number
  erroredTurns: number
  abortedTurns: number
  blockedTurns: number
  maxTokenTurns: number
  interruptedTurns: number
  modelCalls: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

interface ProbeDocument {
  readonly schema: 'dsh-eval-probe'
  readonly schemaVersion: 1
  readonly runId: string
  readonly caseId: string
  readonly variant: 'baseline' | 'candidate'
  readonly updatedAt: string
  readonly metrics: ProbeMetrics
}

/** Attach content-free DSH session accounting when the evaluator delegates a private output path. */
export function registerProbe(ctx: Context, outputPath: string | undefined, env: NodeJS.ProcessEnv = process.env): () => void {
  if (outputPath === undefined) return () => undefined
  if (!isAbsolute(outputPath)) throw new Error('dsh-eval probe output path must be absolute')
  const runId = requiredEnvironment(env, 'DSH_EVAL_RUN_ID')
  const caseId = requiredEnvironment(env, 'DSH_EVAL_CASE_ID')
  const variant = requiredVariant(env['DSH_EVAL_VARIANT'])
  const state: MutableProbeMetrics = {
    sessions: new Set(),
    turns: 0,
    completedTurns: 0,
    erroredTurns: 0,
    abortedTurns: 0,
    blockedTurns: 0,
    maxTokenTurns: 0,
    interruptedTurns: 0,
    modelCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  publish()
  const disposeEvent = ctx.on('session/event', (session, event) => {
    state.sessions.add(String(session.id))
    if (accumulate(state, event)) publish()
  })
  const disposeFlush = ctx.on('session/flush', () => { publish() })
  return () => {
    disposeFlush()
    disposeEvent()
    publish()
  }

  function publish(): void {
    const metrics = snapshotMetrics(state)
    const document: ProbeDocument = Object.freeze({
      schema: 'dsh-eval-probe',
      schemaVersion: 1,
      runId,
      caseId,
      variant,
      updatedAt: new Date().toISOString(),
      metrics,
    })
    atomicWriteSync(outputPath as string, `${JSON.stringify(document, null, 2)}\n`)
  }
}

export function readProbeMetrics(path: string, identity: { runId: string; caseId: string; variant: 'baseline' | 'candidate' }): ProbeMetrics | undefined {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`dsh-eval probe output cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const object = record(value, 'probe')
  exactKeys(object, 'probe', ['schema', 'schemaVersion', 'runId', 'caseId', 'variant', 'updatedAt', 'metrics'])
  if (object['schema'] !== 'dsh-eval-probe' || object['schemaVersion'] !== 1) throw new Error('dsh-eval probe output has an unsupported schema')
  if (object['runId'] !== identity.runId || object['caseId'] !== identity.caseId || object['variant'] !== identity.variant) {
    throw new Error('dsh-eval probe output identity does not match the evaluated run')
  }
  const raw = record(object['metrics'], 'probe.metrics')
  const names = [
    'sessions', 'turns', 'completedTurns', 'erroredTurns', 'abortedTurns', 'blockedTurns', 'maxTokenTurns', 'interruptedTurns',
    'modelCalls', 'toolCalls', 'toolErrors', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens',
    'cacheWriteTokens', 'reasoningTokens',
  ] as const
  exactKeys(raw, 'probe.metrics', ['source', 'trust', ...names])
  if (raw['source'] !== 'dsh-eval-probe') throw new Error('dsh-eval probe metrics source is invalid')
  if (raw['trust'] !== 'self-reported') throw new Error('dsh-eval probe metrics trust classification is invalid')
  const metrics: ProbeMetrics = Object.freeze({
    source: 'dsh-eval-probe',
    trust: 'self-reported',
    ...Object.fromEntries(names.map(name => [name, nonNegativeInteger(raw[name], `probe.metrics.${name}`)])),
  } as unknown as ProbeMetrics)
  if (metrics.completedTurns + metrics.erroredTurns + metrics.abortedTurns + metrics.blockedTurns + metrics.maxTokenTurns + metrics.interruptedTurns > metrics.turns) {
    throw new Error('dsh-eval probe turn outcomes exceed observed turns')
  }
  if (metrics.toolErrors > metrics.toolCalls) throw new Error('dsh-eval probe tool errors exceed tool calls')
  return metrics
}

function accumulate(state: MutableProbeMetrics, event: SessionEvent): boolean {
  switch (event.type) {
    case 'turn/start':
      state.turns += 1
      return true
    case 'turn/end':
      if (event.data.reason.kind === 'completed') state.completedTurns += 1
      else if (event.data.reason.kind === 'error') state.erroredTurns += 1
      else if (event.data.reason.kind === 'aborted') state.abortedTurns += 1
      else if (event.data.reason.kind === 'blocked') state.blockedTurns += 1
      else if (event.data.reason.kind === 'max-tokens') state.maxTokenTurns += 1
      else if (event.data.reason.kind === 'interrupted') state.interruptedTurns += 1
      return true
    case 'step/start':
      state.modelCalls += 1
      return true
    case 'tool/call':
      state.toolCalls += 1
      return true
    case 'tool/result':
      if (event.data.error !== undefined || event.data.message.content.some(block => block.type === 'tool-result' && block.isError === true)) {
        state.toolErrors += 1
      }
      return true
    case 'assistant/message': {
      const usage = event.data.usage
      if (usage === undefined) return false
      const compatibleUsage = usage as typeof usage & { readonly totalTokens?: number }
      state.inputTokens += usage.inputTokens
      state.outputTokens += usage.outputTokens
      state.cacheReadTokens += usage.cacheReadTokens ?? 0
      state.cacheWriteTokens += usage.cacheWriteTokens ?? 0
      state.reasoningTokens += usage.reasoningTokens ?? 0
      state.totalTokens += compatibleUsage.totalTokens
        ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      return true
    }
    default:
      return false
  }
}

function snapshotMetrics(state: MutableProbeMetrics): ProbeMetrics {
  return Object.freeze({
    source: 'dsh-eval-probe',
    trust: 'self-reported',
    sessions: state.sessions.size,
    turns: state.turns,
    completedTurns: state.completedTurns,
    erroredTurns: state.erroredTurns,
    abortedTurns: state.abortedTurns,
    blockedTurns: state.blockedTurns,
    maxTokenTurns: state.maxTokenTurns,
    interruptedTurns: state.interruptedTurns,
    modelCalls: state.modelCalls,
    toolCalls: state.toolCalls,
    toolErrors: state.toolErrors,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    totalTokens: state.totalTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
    reasoningTokens: state.reasoningTokens,
  })
}

function atomicWriteSync(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.length === 0) throw new Error(`dsh-eval probe requires ${name}`)
  return value
}

function requiredVariant(value: string | undefined): 'baseline' | 'candidate' {
  if (value !== 'baseline' && value !== 'candidate') throw new Error('dsh-eval probe requires a valid DSH_EVAL_VARIANT')
  return value
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(object: Record<string, unknown>, label: string, names: readonly string[]): void {
  const allowed = new Set(names)
  const unknown = Object.keys(object).find(name => !allowed.has(name))
  if (unknown !== undefined) throw new Error(`${label} contains unknown key ${unknown}`)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
  return value
}
