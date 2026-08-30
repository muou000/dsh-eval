/** JSON values accepted by manifests, assertions, and reports. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type EvalSplit = 'development' | 'validation' | 'test'
export type EvalVariantRole = 'baseline' | 'candidate'
export type AssertionCategory = 'quality' | 'safety' | 'privacy' | 'stability'

export interface EvalVariant {
  /** Stable variant identifier, separate from the baseline/candidate role. */
  readonly id: string
  /** Immutable code, prompt, profile, or package revision under test. */
  readonly revision: string
  /** Executable name or absolute path. `{manifestDir}` is expanded. */
  readonly executable: string
  /** Literal argv entries. `{manifestDir}` and `{workspace}` are expanded. */
  readonly args?: readonly string[]
  /** How the case task is delivered to the process. */
  readonly taskInput?: 'argument' | 'stdin' | 'none'
  /** Non-secret literal environment. Secret-like names must use `inheritEnv`. */
  readonly env?: Readonly<Record<string, string>>
  /** Parent environment names explicitly delegated to the evaluated process. */
  readonly inheritEnv?: readonly string[]
  /** Candidate-controlled files/directories hashed by the evaluator, relative to the manifest. */
  readonly artifacts?: readonly string[]
  /** Artifact that resolves to the executable or one literal argv entry used to launch this variant. */
  readonly entryArtifact?: string
  /** Explicit model/runtime identity; required operationally for DSH model comparisons. */
  readonly runtime?: {
    readonly harnessVersion: string
    readonly profile: string
    readonly provider?: string
    readonly model?: string
    readonly sampling?: {
      readonly temperature?: number | null
      readonly topP?: number | null
      readonly seed?: number | null
      readonly maxOutputTokens?: number | null
    }
  }
  /** Pinned rates used only with trusted probe token counts. */
  readonly pricing?: {
    readonly inputUsdPerMillion: number
    readonly outputUsdPerMillion: number
    readonly cacheReadUsdPerMillion?: number
    readonly cacheWriteUsdPerMillion?: number
  }
}

export interface EvalExecution {
  readonly splits?: readonly EvalSplit[]
  readonly repetitions?: number
  readonly seed?: number
  readonly timeoutMs?: number
  readonly scorerTimeoutMs?: number
  readonly maxOutputBytes?: number
  readonly maxConcurrency?: number
  readonly keepWorkspaces?: 'never' | 'failed' | 'always'
}

export interface EvalThresholds {
  readonly minimumCandidateSuccessRate?: number
  readonly minimumSuccessRateDelta?: number
  readonly minimumMeanScoreDelta?: number
  readonly maximumPairRegressionCount?: number
  readonly maximumTaskRegressionCount?: number
  readonly maximumMeanDurationRegressionRatio?: number
  readonly maximumP95DurationRegressionRatio?: number
  readonly maximumMeanTotalTokensRegressionRatio?: number
  readonly maximumMeanEstimatedCostRegressionRatio?: number
  readonly requireNoSafetyRegression?: boolean
  readonly requireNoPrivacyRegression?: boolean
  readonly requireNoStabilityRegression?: boolean
}

export interface EvalManifest {
  readonly schema: 'dsh-eval-manifest'
  readonly schemaVersion: 1
  readonly id: string
  readonly description?: string
  readonly dataset: {
    readonly id: string
    readonly version: string
    /** Paths relative to this manifest. */
    readonly caseFiles: readonly string[]
  }
  readonly variants: {
    readonly baseline: EvalVariant
    readonly candidate: EvalVariant
  }
  readonly execution?: EvalExecution
  /** Pre-registered release policy. Omission yields a non-promotable evidence report. */
  readonly thresholds?: EvalThresholds
}

interface AssertionBase {
  readonly id: string
  readonly category?: AssertionCategory
  readonly required?: boolean
  readonly weight?: number
}

export interface FileExistsAssertion extends AssertionBase {
  readonly kind: 'file-exists'
  readonly path: string
  readonly entryType?: 'file' | 'directory' | 'symlink'
}

export interface FileAbsentAssertion extends AssertionBase {
  readonly kind: 'file-absent'
  readonly path: string
}

export interface FileContentAssertion extends AssertionBase {
  readonly kind: 'file-content'
  readonly path: string
  readonly operator: 'equals' | 'contains' | 'matches' | 'sha256'
  readonly expected: string
  readonly flags?: string
}

export interface JsonValueAssertion extends AssertionBase {
  readonly kind: 'json-value'
  readonly path: string
  /** RFC 6901 JSON Pointer; the empty string selects the document root. */
  readonly pointer: string
  readonly operator: 'equals' | 'exists' | 'not-exists'
  readonly expected?: JsonValue
}

export interface TrustedScriptAssertion extends AssertionBase {
  readonly kind: 'trusted-script'
  /** Node.js script path relative to the case file, never copied into the candidate workspace. */
  readonly script: string
  readonly args?: readonly string[]
  readonly expectedExitCode?: number
}

export type EvalAssertion =
  | FileExistsAssertion
  | FileAbsentAssertion
  | FileContentAssertion
  | JsonValueAssertion
  | TrustedScriptAssertion

export interface EvalCase {
  readonly schema: 'dsh-eval-case'
  readonly schemaVersion: 1
  readonly id: string
  readonly family: string
  readonly split: EvalSplit
  readonly task: string
  /** Directory path relative to the case file. It is copied into a private workspace. */
  readonly fixture?: string
  readonly expectedExitCode?: number
  readonly assertions: readonly EvalAssertion[]
  readonly labels?: readonly string[]
}

export interface LoadedEvalCase extends EvalCase {
  readonly sourcePath: string
  readonly sourceDirectory: string
  readonly fixtureSha256?: string
  readonly trustedScriptSha256: Readonly<Record<string, string>>
}

export interface LoadedEvalManifest extends EvalManifest {
  readonly sourcePath: string
  readonly sourceDirectory: string
  readonly cases: readonly LoadedEvalCase[]
  readonly manifestHash: string
  readonly datasetHash: string
  readonly scorerHash: string
  readonly variantHashes: Readonly<Record<EvalVariantRole, string>>
  readonly variantArtifactSha256: Readonly<Record<EvalVariantRole, Readonly<Record<string, string>>>>
}

export interface ProcessOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly spawnError?: string
  readonly durationMs: number
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly stdoutSha256: string
  readonly stderrSha256: string
  readonly stdout?: string
  readonly stderr?: string
}

export interface WorkspaceChange {
  readonly path: string
  readonly kind: 'added' | 'removed' | 'modified'
  readonly beforeSha256?: string
  readonly afterSha256?: string
}

export interface AssertionResult {
  readonly id: string
  readonly kind: EvalAssertion['kind'] | 'process-exit'
  readonly category: AssertionCategory
  readonly required: boolean
  readonly weight: number
  readonly passed: boolean
  readonly message: string
  readonly actualSha256?: string
}

export interface ProbeMetrics {
  readonly source: 'dsh-eval-probe'
  /** The evaluated process can write this channel; it is informational, not promotion-grade evidence. */
  readonly trust: 'self-reported'
  readonly sessions: number
  readonly turns: number
  readonly completedTurns: number
  readonly erroredTurns: number
  readonly abortedTurns: number
  readonly blockedTurns: number
  readonly maxTokenTurns: number
  readonly interruptedTurns: number
  readonly modelCalls: number
  readonly toolCalls: number
  readonly toolErrors: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
}

export interface EvaluationRunResult {
  readonly runId: string
  readonly pairId: string
  readonly order: number
  readonly role: EvalVariantRole
  readonly variantId: string
  readonly variantRevision: string
  readonly variantHash: string
  readonly runtime?: EvalVariant['runtime']
  readonly caseId: string
  readonly family: string
  readonly split: EvalSplit
  readonly repetition: number
  readonly success: boolean
  readonly score: number
  readonly process: ProcessOutcome
  readonly assertions: readonly AssertionResult[]
  readonly workspaceBeforeSha256: string
  readonly workspaceAfterSha256: string
  readonly workspaceChanges: readonly WorkspaceChange[]
  readonly probe?: ProbeMetrics
  readonly estimatedCostUsd?: number
  readonly retainedWorkspace?: string
}

export interface DistributionSummary {
  readonly count: number
  readonly mean: number
  readonly standardDeviation: number
  readonly p50: number
  readonly p95: number
  readonly min: number
  readonly max: number
}

export interface VariantSummary {
  readonly role: EvalVariantRole
  readonly variantId: string
  readonly variantRevision: string
  readonly variantHash: string
  readonly runtime?: EvalVariant['runtime']
  readonly runs: number
  readonly successes: number
  readonly successRate: number
  readonly successRateWilson95: readonly [number, number]
  readonly score: DistributionSummary
  readonly durationMs: DistributionSummary
  readonly totalTokens?: DistributionSummary
  readonly estimatedCostUsd?: DistributionSummary
  readonly safetyFailures: number
  readonly privacyFailures: number
  readonly stabilityFailures: number
}

export interface PairSummary {
  readonly pairs: number
  readonly candidateImproved: number
  readonly candidateRegressed: number
  readonly candidateTaskRegressed: number
  readonly tied: number
  readonly successRateDelta: number
  readonly scoreDeltaMean: number
  readonly scoreDelta: DistributionSummary
}

export interface ThresholdResult {
  readonly name: keyof EvalThresholds
  readonly passed: boolean
  readonly actual: number | boolean | null
  readonly expected: number | boolean
  readonly message: string
}

export interface EvaluationReport {
  readonly schema: 'dsh-eval-report'
  readonly schemaVersion: 1
  readonly evaluatorVersion: string
  /** SHA-256 of the evaluator module file actually loaded for this run. */
  readonly evaluatorArtifactSha256: string
  readonly runId: string
  readonly startedAt: string
  readonly completedAt: string
  readonly manifestId: string
  readonly manifestHash: string
  readonly datasetId: string
  readonly datasetVersion: string
  readonly datasetHash: string
  readonly scorerHash: string
  readonly execution: Required<EvalExecution>
  readonly selectedSplits: readonly EvalSplit[]
  readonly host: {
    readonly platform: NodeJS.Platform
    readonly arch: string
    readonly node: string
  }
  readonly baseline: VariantSummary
  readonly candidate: VariantSummary
  readonly paired: PairSummary
  readonly thresholds: readonly ThresholdResult[]
  readonly decision: 'pass' | 'fail' | 'not-configured'
  /** Local command execution is reproducible but does not isolate a hostile candidate from evaluator inputs. */
  readonly assurance: 'local-trusted-process'
  /** Always false for the local runner; promotion requires externally isolated execution and trusted telemetry. */
  readonly promotionEligible: false
  readonly promotionBlockers: readonly string[]
  readonly runs: readonly EvaluationRunResult[]
}

export interface EvaluationOptions {
  readonly splits?: readonly EvalSplit[]
  readonly outputPath?: string
  readonly signal?: AbortSignal
  readonly includeProcessOutput?: boolean
}
