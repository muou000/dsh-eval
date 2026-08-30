import { describe, expect, it } from 'vitest'
import { evaluateThresholds, reportDecision, summarizePairs, summarizeVariant } from '../src/report.ts'
import type { EvaluationRunResult } from '../src/types.ts'

describe('paired statistics and release gates', () => {
  it('ranks task success before optional score and counts task regressions separately', () => {
    const runs = [
      run('baseline', 'one', true, 0.1),
      run('candidate', 'one', false, 1),
      run('baseline', 'two', true, 0.7),
      run('candidate', 'two', true, 0.6),
    ]
    const paired = summarizePairs(runs)
    expect(paired).toMatchObject({
      pairs: 2,
      candidateImproved: 0,
      candidateRegressed: 2,
      candidateTaskRegressed: 1,
      tied: 0,
    })
    const baseline = summarizeVariant('baseline', runs.filter(run => run.role === 'baseline'))
    const candidate = summarizeVariant('candidate', runs.filter(run => run.role === 'candidate'))
    const thresholds = evaluateThresholds({ maximumTaskRegressionCount: 0 }, baseline, candidate, paired, runs)
    expect(thresholds[0]).toMatchObject({ passed: false, actual: 1, expected: 0 })
  })

  it('fails configured token and cost gates when trusted metrics are incomplete', () => {
    const runs = [run('baseline', 'one', true, 1), run('candidate', 'one', true, 1)]
    const baseline = summarizeVariant('baseline', [runs[0] as EvaluationRunResult])
    const candidate = summarizeVariant('candidate', [runs[1] as EvaluationRunResult])
    const paired = summarizePairs(runs)
    const thresholds = evaluateThresholds({
      maximumMeanTotalTokensRegressionRatio: 0.2,
      maximumMeanEstimatedCostRegressionRatio: 0.2,
    }, baseline, candidate, paired, runs)
    expect(thresholds).toHaveLength(2)
    expect(thresholds.every(threshold => !threshold.passed && threshold.actual === null)).toBe(true)
    expect(reportDecision(thresholds)).toBe('fail')
  })

  it('does not treat disabled category requirements as release gates', () => {
    const runs = [run('baseline', 'one', true, 1), run('candidate', 'one', true, 1)]
    const baseline = summarizeVariant('baseline', [runs[0] as EvaluationRunResult])
    const candidate = summarizeVariant('candidate', [runs[1] as EvaluationRunResult])
    const thresholds = evaluateThresholds({ requireNoSafetyRegression: false }, baseline, candidate, summarizePairs(runs), runs)
    expect(thresholds).toEqual([])
    expect(reportDecision(thresholds)).toBe('not-configured')
  })
})

function run(role: 'baseline' | 'candidate', pairId: string, success: boolean, score: number): EvaluationRunResult {
  return {
    runId: `${pairId}-${role}`,
    pairId,
    order: 0,
    role,
    variantId: role,
    variantRevision: role,
    variantHash: role.repeat(64).slice(0, 64),
    caseId: pairId,
    family: 'test',
    split: 'validation',
    repetition: 1,
    success,
    score,
    process: {
      exitCode: success ? 0 : 1,
      signal: null,
      timedOut: false,
      aborted: false,
      durationMs: role === 'baseline' ? 10 : 11,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutSha256: '0'.repeat(64),
      stderrSha256: '0'.repeat(64),
    },
    assertions: [{
      id: 'process-exit',
      kind: 'process-exit',
      category: 'stability',
      required: true,
      weight: 0,
      passed: success,
      message: 'test',
    }],
    workspaceBeforeSha256: '0'.repeat(64),
    workspaceAfterSha256: '0'.repeat(64),
    workspaceChanges: [],
  }
}
