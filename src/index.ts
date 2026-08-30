/** Evidence-first paired evaluation and release gates for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import { ConfigSchema, resolveConfig } from './config.ts'
import type { Config as EvaluationConfig } from './config.ts'
import { registerProbe } from './probe.ts'
import { EvaluationService } from './service.ts'

export { ConfigSchema, resolveConfig } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { Evaluator } from './evaluator.ts'
export { buildChildEnvironment, materializeVariant } from './environment.ts'
export { canonicalJson, digestTree, InputIntegrityError, resolveInside, sha256 } from './integrity.ts'
export { loadManifest } from './manifest.ts'
export { persistReport } from './persistence.ts'
export { readProbeMetrics, registerProbe } from './probe.ts'
export { runProcess } from './process-runner.ts'
export { evaluateThresholds, renderMarkdownReport, summarizePairs, summarizeVariant } from './report.ts'
export { scoreRun } from './scorers.ts'
export { EvaluationService } from './service.ts'
export type * from './types.ts'
export { EVALUATOR_VERSION } from './version.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-eval'

/** User-configurable plugin options. */
export type Config = EvaluationConfig

/** Runtime configuration schema. Cross-field constraints are enforced by `resolveConfig`. */
export const Config = ConfigSchema

/** The probe observes durable session events; the evaluator service itself is model-independent. */
export const inject = ['sessions']

/** Mount the evaluator service and activate content-free accounting only for evaluator-spawned processes. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  new EvaluationService(ctx, resolved)
  ctx.effect(() => registerProbe(ctx, resolved.probeOutputPath))
  if (resolved.logLifecycle) {
    ctx.effect(() => {
      ctx.logger('dsh-eval').info('loaded reports=%s runs=%s probe=%s', resolved.reportsPath, resolved.runsPath, resolved.probeOutputPath === undefined ? 'disabled' : 'enabled')
      return () => ctx.logger('dsh-eval').info('unloaded')
    })
  }
}
