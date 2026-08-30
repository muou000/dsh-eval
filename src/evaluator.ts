import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from './config.ts'
import { buildChildEnvironment, materializeVariant } from './environment.ts'
import { sha256 } from './integrity.ts'
import { assertCaseInputsUnchanged, assertVariantArtifactsUnchanged, loadManifest } from './manifest.ts'
import { persistReport } from './persistence.ts'
import { readProbeMetrics } from './probe.ts'
import { runProcess } from './process-runner.ts'
import {
  evaluateThresholds,
  renderMarkdownReport,
  reportDecision,
  summarizePairs,
  summarizeVariant,
} from './report.ts'
import { scoreRun } from './scorers.ts'
import type {
  AssertionResult,
  EvalExecution,
  EvalSplit,
  EvalVariant,
  EvalVariantRole,
  EvaluationOptions,
  EvaluationReport,
  EvaluationRunResult,
  LoadedEvalCase,
  LoadedEvalManifest,
  ProbeMetrics,
} from './types.ts'
import { EVALUATOR_VERSION } from './version.ts'
import {
  createRunWorkspace,
  diffWorkspace,
  removeRunWorkspace,
  snapshotWorkspace,
  snapshotVariantArtifacts,
} from './workspace.ts'

interface PlannedRun {
  readonly order: number
  readonly pairId: string
  readonly role: EvalVariantRole
  readonly variant: EvalVariant
  readonly evalCase: LoadedEvalCase
  readonly repetition: number
}

interface PlannedPair {
  readonly runs: readonly [PlannedRun, PlannedRun]
}

/** Deterministic paired evaluator for trusted local candidate processes. */
export class Evaluator {
  private readonly controllers = new Set<AbortController>()
  private readonly pending = new Set<Promise<unknown>>()
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(readonly config: ResolvedConfig) {}

  async run(manifest: string | LoadedEvalManifest, options: EvaluationOptions = {}): Promise<EvaluationReport> {
    if (this.disposed) throw new Error('dsh-eval evaluator is disposed')
    const controller = new AbortController()
    const relayAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', relayAbort, { once: true })
    if (options.signal?.aborted === true) relayAbort()
    this.controllers.add(controller)
    const promise = this.execute(manifest, options, controller)
    this.pending.add(promise)
    try {
      return await promise
    } finally {
      options.signal?.removeEventListener('abort', relayAbort)
      this.controllers.delete(controller)
      this.pending.delete(promise)
    }
  }

  async dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposed = true
      for (const controller of this.controllers) controller.abort(new Error('dsh-eval evaluator disposed'))
      await Promise.allSettled([...this.pending])
    })()
    await this.disposePromise
  }

  private async execute(
    input: string | LoadedEvalManifest,
    options: EvaluationOptions,
    controller: AbortController,
  ): Promise<EvaluationReport> {
    const manifest = typeof input === 'string' ? await loadManifest(input) : input
    const evaluatorArtifactSha256 = sha256(await readFile(fileURLToPath(import.meta.url)))
    await assertVariantArtifactsUnchanged(manifest)
    const execution = resolveExecution(manifest, this.config, options.splits)
    const cases = manifest.cases.filter(evalCase => execution.splits.includes(evalCase.split))
    if (cases.length === 0) throw new Error(`dsh-eval selected splits contain no cases: ${execution.splits.join(', ')}`)
    const runId = createEvaluationRunId(manifest.id)
    const startedAt = new Date().toISOString()
    const planned = planPairs(manifest, cases, execution)
    const pairedResults = await runWithConcurrency(planned, execution.maxConcurrency, controller, async pair => {
      const results: EvaluationRunResult[] = []
      for (const plan of pair.runs) {
        throwIfAborted(controller.signal)
        await assertVariantArtifactsUnchanged(manifest)
        results.push(await this.runOne(
          runId,
          manifest,
          plan,
          execution,
          options.includeProcessOutput ?? this.config.includeProcessOutput,
          controller.signal,
        ))
        await assertVariantArtifactsUnchanged(manifest)
      }
      return Object.freeze(results)
    })
    if (controller.signal.aborted) throw abortError(controller.signal.reason)
    await assertVariantArtifactsUnchanged(manifest)
    await assertCaseInputsUnchanged(manifest)
    const results = pairedResults.flat()
    results.sort((left, right) => left.order - right.order)
    const baseline = summarizeVariant('baseline', results.filter(result => result.role === 'baseline'))
    const candidate = summarizeVariant('candidate', results.filter(result => result.role === 'candidate'))
    const paired = summarizePairs(results)
    const thresholds = evaluateThresholds(manifest.thresholds, baseline, candidate, paired, results)
    const decision = reportDecision(thresholds)
    const report: EvaluationReport = Object.freeze({
      schema: 'dsh-eval-report',
      schemaVersion: 1,
      evaluatorVersion: EVALUATOR_VERSION,
      evaluatorArtifactSha256,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      manifestId: manifest.id,
      manifestHash: manifest.manifestHash,
      datasetId: manifest.dataset.id,
      datasetVersion: manifest.dataset.version,
      datasetHash: manifest.datasetHash,
      scorerHash: manifest.scorerHash,
      execution,
      selectedSplits: execution.splits,
      host: Object.freeze({ platform: process.platform, arch: process.arch, node: process.version }),
      baseline,
      candidate,
      paired,
      thresholds,
      decision,
      assurance: 'local-trusted-process',
      promotionEligible: false,
      promotionBlockers: Object.freeze([
        'local runner does not isolate a hostile candidate from evaluator inputs',
        'probe token and cost metrics are candidate-writable self-reports',
        'normal-exit descendant containment requires an external supervisor or sandbox',
      ]),
      runs: Object.freeze(results),
    })
    const markdown = renderMarkdownReport({
      runId,
      manifestId: manifest.id,
      datasetId: manifest.dataset.id,
      datasetVersion: manifest.dataset.version,
      decision,
      baseline,
      candidate,
      paired,
      thresholds,
      manifestHash: manifest.manifestHash,
      datasetHash: manifest.datasetHash,
      scorerHash: manifest.scorerHash,
      evaluatorArtifactSha256,
    })
    const outputPath = options.outputPath ?? resolve(this.config.reportsPath, `${runId}.json`)
    await persistReport(report, markdown, outputPath)
    return report
  }

  private async runOne(
    evaluationRunId: string,
    manifest: LoadedEvalManifest,
    plan: PlannedRun,
    execution: Required<EvalExecution>,
    includeProcessOutput: boolean,
    signal: AbortSignal,
  ): Promise<EvaluationRunResult> {
    throwIfAborted(signal)
    const fixturePath = plan.evalCase.fixture === undefined ? undefined : resolve(plan.evalCase.sourceDirectory, plan.evalCase.fixture)
    const run = await createRunWorkspace(this.config, fixturePath, plan.evalCase.fixtureSha256)
    let retained = false
    try {
      const variantInput = await snapshotVariantArtifacts(
        run,
        manifest.sourceDirectory,
        manifest.variantArtifactSha256[plan.role],
      )
      const before = await snapshotWorkspace(run.workspace, this.config)
      const attemptId = `${evaluationRunId}-${String(plan.order).padStart(5, '0')}`
      const context = {
        workspace: run.workspace,
        home: run.home,
        probeFile: run.probeFile,
        runId: attemptId,
        caseId: plan.evalCase.id,
        role: plan.role,
        manifestDirectory: variantInput.directory,
      } as const
      const command = materializeVariant(plan.variant, context, plan.evalCase.task)
      const outcome = await runProcess({
        executable: command.executable,
        args: command.args,
        cwd: run.workspace,
        env: buildChildEnvironment(plan.variant, context),
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
        timeoutMs: execution.timeoutMs,
        maxOutputBytes: execution.maxOutputBytes,
        includeOutput: includeProcessOutput,
        signal,
      })
      if (signal.aborted || outcome.aborted) throw abortError(signal.reason)
      await variantInput.assertUnchanged()
      await assertVariantArtifactsUnchanged(manifest)

      let after = before
      let snapshotFailure: string | undefined
      try {
        after = await snapshotWorkspace(run.workspace, this.config)
      } catch (error) {
        snapshotFailure = sanitizeInfrastructureError(error)
      }
      const scored = await scoreRun(plan.evalCase, run.workspace, outcome, this.config, execution.scorerTimeoutMs, signal)
      const snapshotAssertion: AssertionResult | undefined = snapshotFailure === undefined ? undefined : Object.freeze({
        id: 'workspace-snapshot',
        kind: 'file-exists',
        category: 'stability',
        required: true,
        weight: 0,
        passed: false,
        message: `scorer_error=${snapshotFailure}`,
      })
      const assertions = snapshotAssertion === undefined
        ? scored.assertions
        : Object.freeze([...scored.assertions, snapshotAssertion])
      const success = scored.success && snapshotAssertion === undefined
      const probe = readProbeMetrics(run.probeFile, { runId: attemptId, caseId: plan.evalCase.id, variant: plan.role })
      const estimatedCostUsd = probe === undefined || plan.variant.pricing === undefined
        ? undefined
        : estimateCost(probe, plan.variant.pricing)
      retained = !signal.aborted && (execution.keepWorkspaces === 'always' || execution.keepWorkspaces === 'failed' && !success)
      const result: EvaluationRunResult = Object.freeze({
        runId: attemptId,
        pairId: plan.pairId,
        order: plan.order,
        role: plan.role,
        variantId: plan.variant.id,
        variantRevision: plan.variant.revision,
        variantHash: manifest.variantHashes[plan.role],
        ...(plan.variant.runtime === undefined ? {} : { runtime: plan.variant.runtime }),
        caseId: plan.evalCase.id,
        family: plan.evalCase.family,
        split: plan.evalCase.split,
        repetition: plan.repetition,
        success,
        score: scored.score,
        process: outcome,
        assertions,
        workspaceBeforeSha256: before.sha256,
        workspaceAfterSha256: after.sha256,
        workspaceChanges: snapshotFailure === undefined ? diffWorkspace(before, after) : Object.freeze([]),
        ...(probe === undefined ? {} : { probe }),
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
        ...(retained ? { retainedWorkspace: run.workspace } : {}),
      })
      return result
    } finally {
      if (!retained) await removeRunWorkspace(run, this.config.runsPath)
    }
  }
}

function resolveExecution(
  manifest: LoadedEvalManifest,
  config: ResolvedConfig,
  splitOverride: readonly EvalSplit[] | undefined,
): Required<EvalExecution> {
  const registeredSplits = manifest.execution?.splits ?? defaultSplits(manifest)
  if (splitOverride !== undefined && manifest.thresholds !== undefined && !sameSet(splitOverride, registeredSplits)) {
    throw new Error('dsh-eval cannot override pre-registered splits when release thresholds are configured')
  }
  const splits = Object.freeze([...(splitOverride ?? registeredSplits)])
  if (splits.length === 0 || new Set(splits).size !== splits.length) throw new Error('dsh-eval selected splits must be non-empty and unique')
  if (splits.some(split => !['development', 'validation', 'test'].includes(split))) throw new Error('dsh-eval selected splits contain an invalid split')
  const requestedConcurrency = manifest.execution?.maxConcurrency ?? config.maxConcurrency
  const requestedOutputBytes = manifest.execution?.maxOutputBytes ?? config.maxOutputBytes
  if (requestedConcurrency > config.maxConcurrency) throw new Error('dsh-eval manifest maxConcurrency exceeds the operator cap')
  if (requestedOutputBytes > config.maxOutputBytes) throw new Error('dsh-eval manifest maxOutputBytes exceeds the operator cap')
  return Object.freeze({
    splits,
    repetitions: manifest.execution?.repetitions ?? 1,
    seed: manifest.execution?.seed ?? Number.parseInt(manifest.manifestHash.slice(0, 8), 16),
    timeoutMs: manifest.execution?.timeoutMs ?? config.defaultTimeoutMs,
    scorerTimeoutMs: manifest.execution?.scorerTimeoutMs ?? config.defaultScorerTimeoutMs,
    maxOutputBytes: requestedOutputBytes,
    maxConcurrency: requestedConcurrency,
    keepWorkspaces: manifest.execution?.keepWorkspaces ?? config.keepWorkspaces,
  })
}

function defaultSplits(manifest: LoadedEvalManifest): readonly EvalSplit[] {
  const observed = new Set(manifest.cases.map(evalCase => evalCase.split))
  const nonDevelopment = (['validation', 'test'] as const).filter(split => observed.has(split))
  return Object.freeze(nonDevelopment.length > 0 ? nonDevelopment : ['development'])
}

function planPairs(manifest: LoadedEvalManifest, cases: readonly LoadedEvalCase[], execution: Required<EvalExecution>): readonly PlannedPair[] {
  const random = mulberry32(execution.seed)
  const pairs: PlannedPair[] = []
  let order = 0
  for (const evalCase of cases) {
    const initial: readonly [EvalVariantRole, EvalVariantRole] = random() < 0.5
      ? ['baseline', 'candidate']
      : ['candidate', 'baseline']
    for (let repetition = 1; repetition <= execution.repetitions; repetition += 1) {
      const pairId = `${evalCase.id}:${repetition}`
      const roles: readonly [EvalVariantRole, EvalVariantRole] = repetition % 2 === 1
        ? initial
        : [initial[1], initial[0]]
      const runs: PlannedRun[] = []
      for (const role of roles) {
        runs.push(Object.freeze({
          order,
          pairId,
          role,
          variant: manifest.variants[role],
          evalCase,
          repetition,
        }))
        order += 1
      }
      pairs.push(Object.freeze({ runs: Object.freeze(runs) as unknown as readonly [PlannedRun, PlannedRun] }))
    }
  }
  return Object.freeze(pairs)
}

async function runWithConcurrency<T, R>(
  inputs: readonly T[],
  concurrency: number,
  controller: AbortController,
  operation: (input: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(inputs.length)
  let cursor = 0
  let firstError: unknown
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= inputs.length || firstError !== undefined || controller.signal.aborted) return
      try {
        results[index] = await operation(inputs[index] as T)
      } catch (error) {
        firstError ??= error
        controller.abort(error)
        return
      }
    }
  })
  await Promise.allSettled(workers)
  if (firstError !== undefined) throw firstError
  return results
}

function estimateCost(metrics: ProbeMetrics, pricing: NonNullable<EvalVariant['pricing']>): number {
  const cacheReadRate = pricing.cacheReadUsdPerMillion ?? pricing.inputUsdPerMillion
  const cacheWriteRate = pricing.cacheWriteUsdPerMillion ?? pricing.inputUsdPerMillion
  return (
    metrics.inputTokens * pricing.inputUsdPerMillion
    + metrics.outputTokens * pricing.outputUsdPerMillion
    + metrics.cacheReadTokens * cacheReadRate
    + metrics.cacheWriteTokens * cacheWriteRate
  ) / 1_000_000
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function createEvaluationRunId(manifestId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${manifestId}-${timestamp}-${randomUUID().slice(0, 8)}`
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value))
}

function abortError(reason: unknown): Error {
  const error = new Error(`dsh-eval evaluation aborted${reason === undefined ? '' : `: ${sanitizeInfrastructureError(reason)}`}`)
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason)
}

function sanitizeInfrastructureError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 512)
}
