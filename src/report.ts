import type {
  DistributionSummary,
  EvalThresholds,
  EvaluationRunResult,
  PairSummary,
  ThresholdResult,
  VariantSummary,
} from './types.ts'

export function summarizeVariant(role: 'baseline' | 'candidate', runs: readonly EvaluationRunResult[]): VariantSummary {
  if (runs.length === 0) throw new Error(`dsh-eval cannot summarize empty ${role} runs`)
  const first = runs[0] as EvaluationRunResult
  const successes = runs.filter(run => run.success).length
  const tokenValues = runs.map(run => run.probe?.totalTokens)
  const allTokensObserved = tokenValues.every((value): value is number => value !== undefined)
  const costValues = runs.map(run => run.estimatedCostUsd)
  const allCostsObserved = costValues.every((value): value is number => value !== undefined)
  return Object.freeze({
    role,
    variantId: first.variantId,
    variantRevision: first.variantRevision,
    variantHash: first.variantHash,
    ...(first.runtime === undefined ? {} : { runtime: first.runtime }),
    runs: runs.length,
    successes,
    successRate: successes / runs.length,
    successRateWilson95: wilson95(successes, runs.length),
    score: distribution(runs.map(run => run.score)),
    durationMs: distribution(runs.map(run => run.process.durationMs)),
    ...(allTokensObserved ? { totalTokens: distribution(tokenValues) } : {}),
    ...(allCostsObserved ? { estimatedCostUsd: distribution(costValues) } : {}),
    safetyFailures: categoryFailures(runs, 'safety'),
    privacyFailures: categoryFailures(runs, 'privacy'),
    stabilityFailures: categoryFailures(runs, 'stability'),
  })
}

export function summarizePairs(runs: readonly EvaluationRunResult[]): PairSummary {
  const pairs = groupPairs(runs)
  let candidateImproved = 0
  let candidateRegressed = 0
  let candidateTaskRegressed = 0
  let tied = 0
  const scoreDeltas: number[] = []
  for (const pair of pairs) {
    scoreDeltas.push(pair.candidate.score - pair.baseline.score)
    if (pair.baseline.success && !pair.candidate.success) candidateTaskRegressed += 1
    if (pair.candidate.success !== pair.baseline.success) {
      if (pair.candidate.success) candidateImproved += 1
      else candidateRegressed += 1
    } else if (pair.candidate.score > pair.baseline.score + Number.EPSILON) candidateImproved += 1
    else if (pair.candidate.score < pair.baseline.score - Number.EPSILON) candidateRegressed += 1
    else tied += 1
  }
  const baselineSuccess = pairs.filter(pair => pair.baseline.success).length / pairs.length
  const candidateSuccess = pairs.filter(pair => pair.candidate.success).length / pairs.length
  return Object.freeze({
    pairs: pairs.length,
    candidateImproved,
    candidateRegressed,
    candidateTaskRegressed,
    tied,
    successRateDelta: candidateSuccess - baselineSuccess,
    scoreDeltaMean: scoreDeltas.reduce((sum, value) => sum + value, 0) / pairs.length,
    scoreDelta: distribution(scoreDeltas),
  })
}

export function evaluateThresholds(
  thresholds: EvalThresholds | undefined,
  baseline: VariantSummary,
  candidate: VariantSummary,
  paired: PairSummary,
  runs: readonly EvaluationRunResult[],
): readonly ThresholdResult[] {
  if (thresholds === undefined) return Object.freeze([])
  const results: ThresholdResult[] = []
  if (thresholds.minimumCandidateSuccessRate !== undefined) {
    results.push(minimum('minimumCandidateSuccessRate', candidate.successRate, thresholds.minimumCandidateSuccessRate))
  }
  if (thresholds.minimumSuccessRateDelta !== undefined) {
    results.push(minimum('minimumSuccessRateDelta', paired.successRateDelta, thresholds.minimumSuccessRateDelta))
  }
  if (thresholds.minimumMeanScoreDelta !== undefined) {
    results.push(minimum('minimumMeanScoreDelta', paired.scoreDeltaMean, thresholds.minimumMeanScoreDelta))
  }
  if (thresholds.maximumPairRegressionCount !== undefined) {
    results.push(maximum('maximumPairRegressionCount', paired.candidateRegressed, thresholds.maximumPairRegressionCount))
  }
  if (thresholds.maximumTaskRegressionCount !== undefined) {
    results.push(maximum('maximumTaskRegressionCount', paired.candidateTaskRegressed, thresholds.maximumTaskRegressionCount))
  }
  if (thresholds.maximumMeanDurationRegressionRatio !== undefined) {
    results.push(maximumRatio(
      'maximumMeanDurationRegressionRatio',
      baseline.durationMs.mean,
      candidate.durationMs.mean,
      thresholds.maximumMeanDurationRegressionRatio,
    ))
  }
  if (thresholds.maximumP95DurationRegressionRatio !== undefined) {
    results.push(maximumRatio(
      'maximumP95DurationRegressionRatio',
      baseline.durationMs.p95,
      candidate.durationMs.p95,
      thresholds.maximumP95DurationRegressionRatio,
    ))
  }
  if (thresholds.maximumMeanTotalTokensRegressionRatio !== undefined) {
    results.push(Object.freeze({
      name: 'maximumMeanTotalTokensRegressionRatio',
      passed: false,
      actual: null,
      expected: thresholds.maximumMeanTotalTokensRegressionRatio,
      message: 'local probe token metrics are self-reported; use externally isolated trusted telemetry for promotion',
    }))
  }
  if (thresholds.maximumMeanEstimatedCostRegressionRatio !== undefined) {
    results.push(Object.freeze({
      name: 'maximumMeanEstimatedCostRegressionRatio',
      passed: false,
      actual: null,
      expected: thresholds.maximumMeanEstimatedCostRegressionRatio,
      message: 'local probe cost metrics are self-reported; use externally isolated trusted telemetry for promotion',
    }))
  }
  for (const [name, category] of [
    ['requireNoSafetyRegression', 'safety'],
    ['requireNoPrivacyRegression', 'privacy'],
    ['requireNoStabilityRegression', 'stability'],
  ] as const) {
    if (thresholds[name] !== true) continue
    const regressions = categoryRegressions(runs, category)
    const passed = regressions === 0
    results.push(Object.freeze({
      name,
      passed,
      actual: regressions === 0,
      expected: true,
      message: `paired_${category}_regressions=${regressions}`,
    }))
  }
  return Object.freeze(results)
}

export function reportDecision(thresholds: readonly ThresholdResult[]): 'pass' | 'fail' | 'not-configured' {
  if (thresholds.length === 0) return 'not-configured'
  return thresholds.every(threshold => threshold.passed) ? 'pass' : 'fail'
}

export function renderMarkdownReport(input: {
  runId: string
  manifestId: string
  datasetId: string
  datasetVersion: string
  decision: 'pass' | 'fail' | 'not-configured'
  baseline: VariantSummary
  candidate: VariantSummary
  paired: PairSummary
  thresholds: readonly ThresholdResult[]
  manifestHash: string
  datasetHash: string
  scorerHash: string
  evaluatorArtifactSha256: string
}): string {
  const lines = [
    `# dsh-eval report: ${input.runId}`,
    '',
    `Decision: **${input.decision.toUpperCase()}**`,
    '',
    `Manifest: \`${input.manifestId}\``,
    `Dataset: \`${input.datasetId}@${input.datasetVersion}\``,
    '',
    '| Variant | Runs | Success | Mean score | Mean duration (ms) | p95 duration (ms) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    variantRow(input.baseline),
    variantRow(input.candidate),
    '',
    `Paired delta: success ${formatSigned(input.paired.successRateDelta)}, score ${formatSigned(input.paired.scoreDeltaMean)}; improved ${input.paired.candidateImproved}, regressed ${input.paired.candidateRegressed}, tied ${input.paired.tied}.`,
    '',
    'Assurance: `local-trusted-process`. Policy PASS is not an automatic-promotion proof; hostile candidates require external isolation and independently observed telemetry.',
    '',
    '## Release gates',
    '',
  ]
  if (input.thresholds.length === 0) lines.push('No pre-registered thresholds. This report is evidence only and cannot promote a candidate.')
  else {
    lines.push('| Gate | Result | Actual | Expected |', '| --- | --- | ---: | ---: |')
    for (const threshold of input.thresholds) {
      lines.push(`| ${threshold.name} | ${threshold.passed ? 'PASS' : 'FAIL'} | ${String(threshold.actual)} | ${String(threshold.expected)} |`)
    }
  }
  lines.push(
    '',
    '## Input identity',
    '',
    `- Manifest SHA-256: \`${input.manifestHash}\``,
    `- Dataset SHA-256: \`${input.datasetHash}\``,
    `- Scorer SHA-256: \`${input.scorerHash}\``,
    `- Evaluator artifact SHA-256: \`${input.evaluatorArtifactSha256}\``,
    `- Baseline variant SHA-256: \`${input.baseline.variantHash}\``,
    `- Candidate variant SHA-256: \`${input.candidate.variantHash}\``,
  )
  return `${lines.join('\n')}\n`
}

function distribution(values: readonly number[]): DistributionSummary {
  if (values.length === 0) throw new Error('dsh-eval distribution requires observations')
  const sorted = [...values].sort((left, right) => left - right)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.length <= 1
    ? 0
    : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Object.freeze({
    count: sorted.length,
    mean,
    standardDeviation: Math.sqrt(variance),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  })
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number
}

function wilson95(successes: number, total: number): readonly [number, number] {
  const z = 1.959963984540054
  const p = successes / total
  const denominator = 1 + z * z / total
  const centre = (p + z * z / (2 * total)) / denominator
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator
  const lower = Math.max(0, centre - margin)
  const upper = Math.min(1, centre + margin)
  return Object.freeze([lower < 1e-15 ? 0 : lower, upper > 1 - 1e-15 ? 1 : upper])
}

function groupPairs(runs: readonly EvaluationRunResult[]): readonly { baseline: EvaluationRunResult; candidate: EvaluationRunResult }[] {
  const groups = new Map<string, Partial<Record<'baseline' | 'candidate', EvaluationRunResult>>>()
  for (const run of runs) {
    const group = groups.get(run.pairId) ?? {}
    if (group[run.role] !== undefined) throw new Error(`dsh-eval duplicate ${run.role} observation for ${run.pairId}`)
    group[run.role] = run
    groups.set(run.pairId, group)
  }
  return Object.freeze([...groups.entries()].map(([pairId, group]) => {
    if (group.baseline === undefined || group.candidate === undefined) throw new Error(`dsh-eval incomplete pair ${pairId}`)
    return Object.freeze({ baseline: group.baseline, candidate: group.candidate })
  }))
}

function categoryFailures(runs: readonly EvaluationRunResult[], category: 'safety' | 'privacy' | 'stability'): number {
  return runs.filter(run => !categoryPassed(run, category)).length
}

function categoryRegressions(runs: readonly EvaluationRunResult[], category: 'safety' | 'privacy' | 'stability'): number {
  return groupPairs(runs).filter(pair => categoryPassed(pair.baseline, category) && !categoryPassed(pair.candidate, category)).length
}

function categoryPassed(run: EvaluationRunResult, category: 'safety' | 'privacy' | 'stability'): boolean {
  return run.assertions.filter(assertion => assertion.category === category && assertion.required).every(assertion => assertion.passed)
}

function minimum(name: ThresholdResult['name'], actual: number, expected: number): ThresholdResult {
  return Object.freeze({ name, passed: actual >= expected, actual, expected, message: `actual=${actual} minimum=${expected}` })
}

function maximum(name: ThresholdResult['name'], actual: number, expected: number): ThresholdResult {
  return Object.freeze({ name, passed: actual <= expected, actual, expected, message: `actual=${actual} maximum=${expected}` })
}

function maximumRatio(name: ThresholdResult['name'], baseline: number, candidate: number, expected: number): ThresholdResult {
  const actual = baseline === 0 ? (candidate === 0 ? 0 : null) : candidate / baseline - 1
  return Object.freeze({
    name,
    passed: actual !== null && actual <= expected,
    actual,
    expected,
    message: actual === null ? 'baseline is zero while candidate is non-zero' : `regression_ratio=${actual} maximum=${expected}`,
  })
}

function variantRow(summary: VariantSummary): string {
  return `| ${summary.role} (\`${summary.variantId}\`) | ${summary.runs} | ${summary.successes}/${summary.runs} (${formatRate(summary.successRate)}) | ${summary.score.mean.toFixed(4)} | ${summary.durationMs.mean.toFixed(2)} | ${summary.durationMs.p95.toFixed(2)} |`
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`
}
