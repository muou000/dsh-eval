import { Context, Service } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.ts'
import { Evaluator } from './evaluator.ts'
import type { EvaluationOptions, EvaluationReport, LoadedEvalManifest } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    evals: EvaluationService
  }
}

/** Public evaluation capability backed by the deterministic local provider. */
export class EvaluationService extends Service {
  readonly evaluator: Evaluator

  constructor(ctx: Context, readonly config: ResolvedConfig) {
    super(ctx, 'evals')
    this.evaluator = new Evaluator(config)
    ctx.effect(() => async () => this.evaluator.dispose(), 'dsh-eval.evaluator.dispose')
  }

  run(manifest: string | LoadedEvalManifest, options?: EvaluationOptions): Promise<EvaluationReport> {
    return this.evaluator.run(manifest, options)
  }
}
