import type {
  AssertionCategory,
  EvalAssertion,
  EvalCase,
  EvalExecution,
  EvalManifest,
  EvalThresholds,
  EvalVariant,
  JsonValue,
} from './types.ts'
import { isEvaluatorReservedEnvironmentName } from './environment.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_NAME_PATTERN = /(?:api[_-]?key|token|secret|password|credential|private[_-]?key)/i
const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g
const VALID_PLACEHOLDERS = new Set(['manifestDir', 'workspace'])
const CATEGORIES: readonly AssertionCategory[] = ['quality', 'safety', 'privacy', 'stability']

export function parseManifest(value: unknown): EvalManifest {
  const object = asObject(value, 'manifest')
  exactKeys(object, 'manifest', ['schema', 'schemaVersion', 'id', 'description', 'dataset', 'variants', 'execution', 'thresholds'])
  literal(object['schema'], 'dsh-eval-manifest', 'manifest.schema')
  literal(object['schemaVersion'], 1, 'manifest.schemaVersion')
  const id = identifier(object['id'], 'manifest.id')
  const description = optionalString(object['description'], 'manifest.description', 4_096)

  const datasetObject = asObject(object['dataset'], 'manifest.dataset')
  exactKeys(datasetObject, 'manifest.dataset', ['id', 'version', 'caseFiles'])
  const datasetId = identifier(datasetObject['id'], 'manifest.dataset.id')
  const datasetVersion = boundedString(datasetObject['version'], 'manifest.dataset.version', 1, 256)
  const caseFiles = stringArray(datasetObject['caseFiles'], 'manifest.dataset.caseFiles', { minimum: 1, maximum: 10_000 })
  ensureUnique(caseFiles, 'manifest.dataset.caseFiles')
  caseFiles.forEach((path, index) => relativePath(path, `manifest.dataset.caseFiles[${index}]`))

  const variantsObject = asObject(object['variants'], 'manifest.variants')
  exactKeys(variantsObject, 'manifest.variants', ['baseline', 'candidate'])
  const baseline = parseVariant(variantsObject['baseline'], 'manifest.variants.baseline')
  const candidate = parseVariant(variantsObject['candidate'], 'manifest.variants.candidate')
  const execution = object['execution'] === undefined ? undefined : parseExecution(object['execution'])
  const thresholds = object['thresholds'] === undefined ? undefined : parseThresholds(object['thresholds'])
  if (thresholds !== undefined) validateReleasePolicy(baseline, candidate, execution, thresholds)

  return Object.freeze({
    schema: 'dsh-eval-manifest',
    schemaVersion: 1,
    id,
    ...(description === undefined ? {} : { description }),
    dataset: Object.freeze({ id: datasetId, version: datasetVersion, caseFiles: Object.freeze(caseFiles) }),
    variants: Object.freeze({ baseline, candidate }),
    ...(execution === undefined ? {} : { execution }),
    ...(thresholds === undefined ? {} : { thresholds }),
  })
}

export function parseCase(value: unknown): EvalCase {
  const object = asObject(value, 'case')
  exactKeys(object, 'case', [
    'schema', 'schemaVersion', 'id', 'family', 'split', 'task', 'fixture', 'expectedExitCode', 'assertions', 'labels',
  ])
  literal(object['schema'], 'dsh-eval-case', 'case.schema')
  literal(object['schemaVersion'], 1, 'case.schemaVersion')
  const id = identifier(object['id'], 'case.id')
  const family = identifier(object['family'], 'case.family')
  const split = oneOf(object['split'], ['development', 'validation', 'test'] as const, 'case.split')
  const task = boundedString(object['task'], 'case.task', 1, 1_000_000)
  const fixture = optionalString(object['fixture'], 'case.fixture', 4_096)
  if (fixture !== undefined) sourceRelativePath(fixture, 'case.fixture')
  const expectedExitCode = optionalInteger(object['expectedExitCode'], 'case.expectedExitCode', -2_147_483_648, 2_147_483_647)
  if (!Array.isArray(object['assertions'])) throw new Error('case.assertions must be an array')
  if (object['assertions'].length === 0) throw new Error('case.assertions must contain at least one external-world assertion')
  if (object['assertions'].length > 1_000) throw new Error('case.assertions must contain at most 1000 entries')
  const assertions = object['assertions'].map((assertion, index) => parseAssertion(assertion, `case.assertions[${index}]`))
  if (!assertions.some(assertion => assertion.required !== false)) {
    throw new Error('case.assertions must contain at least one required external-world assertion')
  }
  ensureUnique(assertions.map(assertion => assertion.id), 'case assertion ids')
  const labels = object['labels'] === undefined
    ? undefined
    : stringArray(object['labels'], 'case.labels', { minimum: 0, maximum: 100 }).map((label, index) => identifier(label, `case.labels[${index}]`))
  if (labels !== undefined) ensureUnique(labels, 'case.labels')

  return Object.freeze({
    schema: 'dsh-eval-case',
    schemaVersion: 1,
    id,
    family,
    split,
    task,
    ...(fixture === undefined ? {} : { fixture }),
    ...(expectedExitCode === undefined ? {} : { expectedExitCode }),
    assertions: Object.freeze(assertions),
    ...(labels === undefined ? {} : { labels: Object.freeze(labels) }),
  })
}

function parseVariant(value: unknown, label: string): EvalVariant {
  const object = asObject(value, label)
  exactKeys(object, label, ['id', 'revision', 'executable', 'args', 'taskInput', 'env', 'inheritEnv', 'artifacts', 'entryArtifact', 'runtime', 'pricing'])
  const id = identifier(object['id'], `${label}.id`)
  const revision = boundedString(object['revision'], `${label}.revision`, 1, 512)
  const executable = boundedString(object['executable'], `${label}.executable`, 1, 32_768)
  assertPlaceholders(executable, `${label}.executable`)
  const args = object['args'] === undefined ? undefined : stringArray(object['args'], `${label}.args`, { minimum: 0, maximum: 1_000 })
  args?.forEach((arg, index) => assertPlaceholders(arg, `${label}.args[${index}]`))
  const taskInput = object['taskInput'] === undefined
    ? undefined
    : oneOf(object['taskInput'], ['argument', 'stdin', 'none'] as const, `${label}.taskInput`)

  let env: Readonly<Record<string, string>> | undefined
  if (object['env'] !== undefined) {
    const envObject = asObject(object['env'], `${label}.env`)
    const entries: Array<[string, string]> = []
    for (const [name, raw] of Object.entries(envObject)) {
      if (!ENV_NAME_PATTERN.test(name)) throw new Error(`${label}.env contains an invalid environment name`)
      if (isEvaluatorReservedEnvironmentName(name)) throw new Error(`${label}.env.${name} is reserved by the evaluator`)
      if (SECRET_NAME_PATTERN.test(name)) throw new Error(`${label}.env.${name} is secret-like; delegate it with inheritEnv`)
      const string = boundedString(raw, `${label}.env.${name}`, 0, 32_768)
      assertPlaceholders(string, `${label}.env.${name}`)
      entries.push([name, string])
    }
    env = Object.freeze(Object.fromEntries(entries))
  }
  const inheritEnv = object['inheritEnv'] === undefined
    ? undefined
    : stringArray(object['inheritEnv'], `${label}.inheritEnv`, { minimum: 0, maximum: 100 })
  inheritEnv?.forEach(name => {
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`${label}.inheritEnv contains an invalid environment name`)
    if (isEvaluatorReservedEnvironmentName(name)) throw new Error(`${label}.inheritEnv.${name} is reserved by the evaluator`)
  })
  if (inheritEnv !== undefined) ensureUnique(inheritEnv, `${label}.inheritEnv`)
  const artifacts = object['artifacts'] === undefined
    ? undefined
    : stringArray(object['artifacts'], `${label}.artifacts`, { minimum: 1, maximum: 1_000 })
  artifacts?.forEach((path, index) => relativePath(path, `${label}.artifacts[${index}]`))
  if (artifacts !== undefined) ensureUnique(artifacts, `${label}.artifacts`)
  if (artifacts !== undefined) {
    const normalized = artifacts.map(path => path.replaceAll('\\', '/'))
    if (normalized.some((path, index) => normalized.some((other, otherIndex) => index !== otherIndex && path.startsWith(`${other}/`)))) {
      throw new Error(`${label}.artifacts must not overlap`)
    }
  }
  const entryArtifact = object['entryArtifact'] === undefined
    ? undefined
    : relativePathValue(object['entryArtifact'], `${label}.entryArtifact`)
  if (entryArtifact !== undefined && !artifacts?.includes(entryArtifact)) {
    throw new Error(`${label}.entryArtifact must also appear in ${label}.artifacts`)
  }
  const runtime = object['runtime'] === undefined ? undefined : parseRuntime(object['runtime'], `${label}.runtime`)
  let pricing: EvalVariant['pricing']
  if (object['pricing'] !== undefined) {
    const pricingObject = asObject(object['pricing'], `${label}.pricing`)
    exactKeys(pricingObject, `${label}.pricing`, [
      'inputUsdPerMillion', 'outputUsdPerMillion', 'cacheReadUsdPerMillion', 'cacheWriteUsdPerMillion',
    ])
    const inputUsdPerMillion = requiredNumber(pricingObject['inputUsdPerMillion'], `${label}.pricing.inputUsdPerMillion`, 0, 1_000_000)
    const outputUsdPerMillion = requiredNumber(pricingObject['outputUsdPerMillion'], `${label}.pricing.outputUsdPerMillion`, 0, 1_000_000)
    const cacheReadUsdPerMillion = optionalNumber(pricingObject['cacheReadUsdPerMillion'], `${label}.pricing.cacheReadUsdPerMillion`, 0, 1_000_000)
    const cacheWriteUsdPerMillion = optionalNumber(pricingObject['cacheWriteUsdPerMillion'], `${label}.pricing.cacheWriteUsdPerMillion`, 0, 1_000_000)
    pricing = Object.freeze({
      inputUsdPerMillion,
      outputUsdPerMillion,
      ...(cacheReadUsdPerMillion === undefined ? {} : { cacheReadUsdPerMillion }),
      ...(cacheWriteUsdPerMillion === undefined ? {} : { cacheWriteUsdPerMillion }),
    })
  }

  return Object.freeze({
    id,
    revision,
    executable,
    ...(args === undefined ? {} : { args: Object.freeze(args) }),
    ...(taskInput === undefined ? {} : { taskInput }),
    ...(env === undefined ? {} : { env }),
    ...(inheritEnv === undefined ? {} : { inheritEnv: Object.freeze(inheritEnv) }),
    ...(artifacts === undefined ? {} : { artifacts: Object.freeze(artifacts) }),
    ...(entryArtifact === undefined ? {} : { entryArtifact }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(pricing === undefined ? {} : { pricing }),
  })
}

function parseRuntime(value: unknown, label: string): NonNullable<EvalVariant['runtime']> {
  const object = asObject(value, label)
  exactKeys(object, label, ['harnessVersion', 'profile', 'provider', 'model', 'sampling'])
  const harnessVersion = boundedString(object['harnessVersion'], `${label}.harnessVersion`, 1, 256)
  const profile = boundedString(object['profile'], `${label}.profile`, 1, 256)
  const provider = optionalString(object['provider'], `${label}.provider`, 256)
  const model = optionalString(object['model'], `${label}.model`, 512)
  if ((provider === undefined) !== (model === undefined)) throw new Error(`${label}.provider and ${label}.model must be declared together`)
  let sampling: NonNullable<NonNullable<EvalVariant['runtime']>['sampling']> | undefined
  if (object['sampling'] !== undefined) {
    const raw = asObject(object['sampling'], `${label}.sampling`)
    exactKeys(raw, `${label}.sampling`, ['temperature', 'topP', 'seed', 'maxOutputTokens'])
    if (provider !== undefined) {
      for (const key of ['temperature', 'topP', 'seed', 'maxOutputTokens']) {
        if (!Object.hasOwn(raw, key)) throw new Error(`${label}.sampling.${key} must be explicitly declared for a model runtime; use null when unsupported`)
      }
    }
    const temperature = optionalNullableNumber(raw['temperature'], `${label}.sampling.temperature`, 0, 100)
    const topP = optionalNullableNumber(raw['topP'], `${label}.sampling.topP`, 0, 1)
    const seed = optionalNullableInteger(raw['seed'], `${label}.sampling.seed`, 0, 4_294_967_295)
    const maxOutputTokens = optionalNullableInteger(raw['maxOutputTokens'], `${label}.sampling.maxOutputTokens`, 1, 10_000_000)
    sampling = Object.freeze({
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { topP }),
      ...(seed === undefined ? {} : { seed }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    })
  }
  if (provider !== undefined && sampling === undefined) throw new Error(`${label}.sampling is required for a model runtime`)
  return Object.freeze({
    harnessVersion,
    profile,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(sampling === undefined ? {} : { sampling }),
  })
}

function parseExecution(value: unknown): EvalExecution {
  const object = asObject(value, 'manifest.execution')
  exactKeys(object, 'manifest.execution', [
    'splits', 'repetitions', 'seed', 'timeoutMs', 'scorerTimeoutMs', 'maxOutputBytes', 'maxConcurrency', 'keepWorkspaces',
  ])
  const splits = object['splits'] === undefined
    ? undefined
    : stringArray(object['splits'], 'manifest.execution.splits', { minimum: 1, maximum: 3 })
      .map((split, index) => oneOf(split, ['development', 'validation', 'test'] as const, `manifest.execution.splits[${index}]`))
  if (splits !== undefined) ensureUnique(splits, 'manifest.execution.splits')
  const repetitions = optionalInteger(object['repetitions'], 'manifest.execution.repetitions', 1, 100)
  const seed = optionalInteger(object['seed'], 'manifest.execution.seed', 0, 4_294_967_295)
  const timeoutMs = optionalInteger(object['timeoutMs'], 'manifest.execution.timeoutMs', 100, 86_400_000)
  const scorerTimeoutMs = optionalInteger(object['scorerTimeoutMs'], 'manifest.execution.scorerTimeoutMs', 100, 3_600_000)
  const maxOutputBytes = optionalInteger(object['maxOutputBytes'], 'manifest.execution.maxOutputBytes', 1_024, 100_000_000)
  const maxConcurrency = optionalInteger(object['maxConcurrency'], 'manifest.execution.maxConcurrency', 1, 16)
  const keepWorkspaces = object['keepWorkspaces'] === undefined
    ? undefined
    : oneOf(object['keepWorkspaces'], ['never', 'failed', 'always'] as const, 'manifest.execution.keepWorkspaces')
  return Object.freeze({
    ...(splits === undefined ? {} : { splits: Object.freeze(splits) }),
    ...(repetitions === undefined ? {} : { repetitions }),
    ...(seed === undefined ? {} : { seed }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(scorerTimeoutMs === undefined ? {} : { scorerTimeoutMs }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    ...(keepWorkspaces === undefined ? {} : { keepWorkspaces }),
  })
}

function parseThresholds(value: unknown): EvalThresholds {
  const object = asObject(value, 'manifest.thresholds')
  const keys = [
    'minimumCandidateSuccessRate',
    'minimumSuccessRateDelta',
    'minimumMeanScoreDelta',
    'maximumPairRegressionCount',
    'maximumTaskRegressionCount',
    'maximumMeanDurationRegressionRatio',
    'maximumP95DurationRegressionRatio',
    'maximumMeanTotalTokensRegressionRatio',
    'maximumMeanEstimatedCostRegressionRatio',
    'requireNoSafetyRegression',
    'requireNoPrivacyRegression',
    'requireNoStabilityRegression',
  ] as const
  exactKeys(object, 'manifest.thresholds', keys)
  const minimumCandidateSuccessRate = optionalNumber(object['minimumCandidateSuccessRate'], 'manifest.thresholds.minimumCandidateSuccessRate', 0, 1)
  const minimumSuccessRateDelta = optionalNumber(object['minimumSuccessRateDelta'], 'manifest.thresholds.minimumSuccessRateDelta', -1, 1)
  const minimumMeanScoreDelta = optionalNumber(object['minimumMeanScoreDelta'], 'manifest.thresholds.minimumMeanScoreDelta', -1, 1)
  const maximumPairRegressionCount = optionalInteger(object['maximumPairRegressionCount'], 'manifest.thresholds.maximumPairRegressionCount', 0, 1_000_000)
  const maximumTaskRegressionCount = optionalInteger(object['maximumTaskRegressionCount'], 'manifest.thresholds.maximumTaskRegressionCount', 0, 1_000_000)
  const maximumMeanDurationRegressionRatio = optionalNumber(object['maximumMeanDurationRegressionRatio'], 'manifest.thresholds.maximumMeanDurationRegressionRatio', 0, 100)
  const maximumP95DurationRegressionRatio = optionalNumber(object['maximumP95DurationRegressionRatio'], 'manifest.thresholds.maximumP95DurationRegressionRatio', 0, 100)
  const maximumMeanTotalTokensRegressionRatio = optionalNumber(object['maximumMeanTotalTokensRegressionRatio'], 'manifest.thresholds.maximumMeanTotalTokensRegressionRatio', 0, 100)
  const maximumMeanEstimatedCostRegressionRatio = optionalNumber(object['maximumMeanEstimatedCostRegressionRatio'], 'manifest.thresholds.maximumMeanEstimatedCostRegressionRatio', 0, 100)
  const requireNoSafetyRegression = optionalBoolean(object['requireNoSafetyRegression'], 'manifest.thresholds.requireNoSafetyRegression')
  const requireNoPrivacyRegression = optionalBoolean(object['requireNoPrivacyRegression'], 'manifest.thresholds.requireNoPrivacyRegression')
  const requireNoStabilityRegression = optionalBoolean(object['requireNoStabilityRegression'], 'manifest.thresholds.requireNoStabilityRegression')
  return Object.freeze({
    ...(minimumCandidateSuccessRate === undefined ? {} : { minimumCandidateSuccessRate }),
    ...(minimumSuccessRateDelta === undefined ? {} : { minimumSuccessRateDelta }),
    ...(minimumMeanScoreDelta === undefined ? {} : { minimumMeanScoreDelta }),
    ...(maximumPairRegressionCount === undefined ? {} : { maximumPairRegressionCount }),
    ...(maximumTaskRegressionCount === undefined ? {} : { maximumTaskRegressionCount }),
    ...(maximumMeanDurationRegressionRatio === undefined ? {} : { maximumMeanDurationRegressionRatio }),
    ...(maximumP95DurationRegressionRatio === undefined ? {} : { maximumP95DurationRegressionRatio }),
    ...(maximumMeanTotalTokensRegressionRatio === undefined ? {} : { maximumMeanTotalTokensRegressionRatio }),
    ...(maximumMeanEstimatedCostRegressionRatio === undefined ? {} : { maximumMeanEstimatedCostRegressionRatio }),
    ...(requireNoSafetyRegression === undefined ? {} : { requireNoSafetyRegression }),
    ...(requireNoPrivacyRegression === undefined ? {} : { requireNoPrivacyRegression }),
    ...(requireNoStabilityRegression === undefined ? {} : { requireNoStabilityRegression }),
  })
}

function validateReleasePolicy(
  baseline: EvalVariant,
  candidate: EvalVariant,
  execution: EvalExecution | undefined,
  thresholds: EvalThresholds,
): void {
  for (const [role, variant] of [['baseline', baseline], ['candidate', candidate]] as const) {
    if ((variant.artifacts?.length ?? 0) === 0) {
      throw new Error(`manifest release thresholds require non-empty artifacts for ${role}`)
    }
    if (variant.entryArtifact === undefined) {
      throw new Error(`manifest release thresholds require ${role}.entryArtifact`)
    }
    if (variant.runtime === undefined) {
      throw new Error(`manifest release thresholds require ${role}.runtime identity`)
    }
  }
  if ((execution?.repetitions ?? 1) < 5) {
    throw new Error('manifest release thresholds require at least 5 repetitions')
  }
  if (execution?.splits?.length !== 1 || execution.splits[0] !== 'test') {
    throw new Error('manifest release thresholds require exactly the held-out test split')
  }
  for (const name of [
    'minimumCandidateSuccessRate',
    'minimumMeanScoreDelta',
    'maximumPairRegressionCount',
    'maximumTaskRegressionCount',
    'maximumMeanDurationRegressionRatio',
    'maximumP95DurationRegressionRatio',
  ] as const) {
    if (thresholds[name] === undefined) throw new Error(`manifest release thresholds require ${name}`)
  }
  for (const name of ['requireNoSafetyRegression', 'requireNoPrivacyRegression', 'requireNoStabilityRegression'] as const) {
    if (thresholds[name] !== true) throw new Error(`manifest release thresholds require ${name}=true`)
  }
  const comparesModelRuntime = baseline.runtime?.model !== undefined || candidate.runtime?.model !== undefined
  if (comparesModelRuntime) {
    if (thresholds.maximumMeanTotalTokensRegressionRatio === undefined) {
      throw new Error('model release thresholds require maximumMeanTotalTokensRegressionRatio')
    }
    if (thresholds.maximumMeanEstimatedCostRegressionRatio === undefined) {
      throw new Error('model release thresholds require maximumMeanEstimatedCostRegressionRatio')
    }
  }
}

function parseAssertion(value: unknown, label: string): EvalAssertion {
  const object = asObject(value, label)
  const kind = boundedString(object['kind'], `${label}.kind`, 1, 64)
  const common = parseAssertionBase(object, label)
  if (kind === 'file-exists') {
    exactKeys(object, label, ['id', 'kind', 'category', 'required', 'weight', 'path', 'entryType'])
    const path = relativePathValue(object['path'], `${label}.path`)
    const entryType = object['entryType'] === undefined ? undefined : oneOf(object['entryType'], ['file', 'directory', 'symlink'] as const, `${label}.entryType`)
    return Object.freeze({ ...common, kind, path, ...(entryType === undefined ? {} : { entryType }) })
  }
  if (kind === 'file-absent') {
    exactKeys(object, label, ['id', 'kind', 'category', 'required', 'weight', 'path'])
    return Object.freeze({ ...common, kind, path: relativePathValue(object['path'], `${label}.path`) })
  }
  if (kind === 'file-content') {
    exactKeys(object, label, ['id', 'kind', 'category', 'required', 'weight', 'path', 'operator', 'expected', 'flags'])
    const operator = oneOf(object['operator'], ['equals', 'contains', 'matches', 'sha256'] as const, `${label}.operator`)
    const expected = boundedString(object['expected'], `${label}.expected`, 0, 10_000_000)
    const flags = optionalString(object['flags'], `${label}.flags`, 16)
    if (flags !== undefined && operator !== 'matches') throw new Error(`${label}.flags requires operator=matches`)
    if (flags !== undefined && !/^[dgimsuvy]*$/.test(flags)) throw new Error(`${label}.flags contains unsupported regular expression flags`)
    if (operator === 'matches') {
      try { void new RegExp(expected, flags) } catch (error) { throw new Error(`${label}.expected is not a valid regular expression: ${String(error)}`) }
    }
    if (operator === 'sha256' && !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${label}.expected must be a lowercase SHA-256 digest`)
    return Object.freeze({
      ...common,
      kind,
      path: relativePathValue(object['path'], `${label}.path`),
      operator,
      expected,
      ...(flags === undefined ? {} : { flags }),
    })
  }
  if (kind === 'json-value') {
    exactKeys(object, label, ['id', 'kind', 'category', 'required', 'weight', 'path', 'pointer', 'operator', 'expected'])
    const pointer = boundedString(object['pointer'], `${label}.pointer`, 0, 16_384)
    if (pointer.length > 0 && !pointer.startsWith('/')) throw new Error(`${label}.pointer must be an RFC 6901 JSON Pointer`)
    const operator = oneOf(object['operator'], ['equals', 'exists', 'not-exists'] as const, `${label}.operator`)
    if (operator === 'equals' && !Object.hasOwn(object, 'expected')) throw new Error(`${label}.expected is required for operator=equals`)
    if (operator !== 'equals' && Object.hasOwn(object, 'expected')) throw new Error(`${label}.expected is only valid for operator=equals`)
    if (Object.hasOwn(object, 'expected')) assertJsonValue(object['expected'], `${label}.expected`)
    return Object.freeze({
      ...common,
      kind,
      path: relativePathValue(object['path'], `${label}.path`),
      pointer,
      operator,
      ...(Object.hasOwn(object, 'expected') ? { expected: object['expected'] as JsonValue } : {}),
    })
  }
  if (kind === 'trusted-script') {
    exactKeys(object, label, ['id', 'kind', 'category', 'required', 'weight', 'script', 'args', 'expectedExitCode'])
    const script = sourceRelativePathValue(object['script'], `${label}.script`)
    const args = object['args'] === undefined ? undefined : stringArray(object['args'], `${label}.args`, { minimum: 0, maximum: 1_000 })
    args?.forEach((arg, index) => assertPlaceholders(arg, `${label}.args[${index}]`))
    const expectedExitCode = optionalInteger(object['expectedExitCode'], `${label}.expectedExitCode`, -2_147_483_648, 2_147_483_647)
    return Object.freeze({
      ...common,
      kind,
      script,
      ...(args === undefined ? {} : { args: Object.freeze(args) }),
      ...(expectedExitCode === undefined ? {} : { expectedExitCode }),
    })
  }
  throw new Error(`${label}.kind is not supported`)
}

function parseAssertionBase(object: Record<string, unknown>, label: string): {
  id: string
  category?: AssertionCategory
  required?: boolean
  weight?: number
} {
  const id = identifier(object['id'], `${label}.id`)
  const category = object['category'] === undefined ? undefined : oneOf(object['category'], CATEGORIES, `${label}.category`)
  const required = optionalBoolean(object['required'], `${label}.required`)
  const weight = optionalNumber(object['weight'], `${label}.weight`, 0, 1_000_000)
  return {
    id,
    ...(category === undefined ? {} : { category }),
    ...(required === undefined ? {} : { required }),
    ...(weight === undefined ? {} : { weight }),
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(object: Record<string, unknown>, label: string, allowed: readonly string[]): void {
  const set = new Set(allowed)
  const unknown = Object.keys(object).find(key => !set.has(key))
  if (unknown !== undefined) throw new Error(`${label} contains unknown key "${unknown}"`)
}

function literal<T extends string | number>(value: unknown, expected: T, label: string): asserts value is T {
  if (value !== expected) throw new Error(`${label} must equal ${JSON.stringify(expected)}`)
}

function identifier(value: unknown, label: string): string {
  const result = boundedString(value, label, 1, 128)
  if (!ID_PATTERN.test(result)) throw new Error(`${label} must use letters, digits, dot, underscore, or hyphen`)
  return result
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must be a string with length in [${minimum}, ${maximum}]`)
  }
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL`)
  return value
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, 0, maximum)
}

function stringArray(value: unknown, label: string, limits: { minimum: number; maximum: number }): string[] {
  if (!Array.isArray(value) || value.length < limits.minimum || value.length > limits.maximum) {
    throw new Error(`${label} must be an array with length in [${limits.minimum}, ${limits.maximum}]`)
  }
  return value.map((entry, index) => boundedString(entry, `${label}[${index}]`, 0, 32_768))
}

function ensureUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`)
}

function relativePathValue(value: unknown, label: string): string {
  const path = boundedString(value, label, 1, 4_096)
  relativePath(path, label)
  return path
}

function sourceRelativePathValue(value: unknown, label: string): string {
  const path = boundedString(value, label, 1, 4_096)
  sourceRelativePath(path, label)
  return path
}

function sourceRelativePath(value: string, label: string): void {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value)) throw new Error(`${label} must be relative`)
  if (value.replaceAll('\\', '/').split('/').includes('')) throw new Error(`${label} must not contain empty segments`)
}

function relativePath(value: string, label: string): void {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value)) throw new Error(`${label} must be relative`)
  const segments = value.replaceAll('\\', '/').split('/')
  if (segments.includes('..') || segments.includes('')) throw new Error(`${label} must not escape or contain empty segments`)
}

function oneOf<const T extends readonly (string | number)[]>(value: unknown, choices: T, label: string): T[number] {
  if (!choices.includes(value as never)) throw new Error(`${label} must be one of ${choices.join(', ')}`)
  return value as T[number]
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in [${minimum}, ${maximum}]`)
  }
  return value
}

function optionalNumber(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number in [${minimum}, ${maximum}]`)
  }
  return value
}

function requiredNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = optionalNumber(value, label, minimum, maximum)
  if (result === undefined) throw new Error(`${label} is required`)
  return result
}

function optionalNullableNumber(value: unknown, label: string, minimum: number, maximum: number): number | null | undefined {
  if (value === null) return null
  return optionalNumber(value, label, minimum, maximum)
}

function optionalNullableInteger(value: unknown, label: string, minimum: number, maximum: number): number | null | undefined {
  if (value === null) return null
  return optionalInteger(value, label, minimum, maximum)
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function assertPlaceholders(value: string, label: string): void {
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    if (!VALID_PLACEHOLDERS.has(match[1] as string)) throw new Error(`${label} contains unknown placeholder {${match[1]}}`)
  }
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${label}.${key}`)
    return
  }
  throw new Error(`${label} must contain JSON data only`)
}
