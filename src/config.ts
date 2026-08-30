import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface Config {
  /** Harness home used to derive default report and run directories. */
  dshHome?: string
  /** Absolute immutable report directory. */
  reportsPath?: string
  /** Absolute private run workspace directory. */
  runsPath?: string
  /** Per-process timeout in milliseconds. */
  defaultTimeoutMs?: number
  /** Timeout for a trusted scorer script in milliseconds. */
  defaultScorerTimeoutMs?: number
  /** Maximum captured bytes for each stdout and stderr stream. */
  maxOutputBytes?: number
  /** Maximum number of evaluated processes running concurrently. */
  maxConcurrency?: number
  /** Maximum entries accepted in one candidate workspace snapshot. */
  maxWorkspaceEntries?: number
  /** Maximum aggregate regular-file bytes accepted in one workspace snapshot. */
  maxWorkspaceBytes?: number
  /** Maximum bytes read by one file or JSON assertion. */
  maxAssertionBytes?: number
  /** Workspace retention policy used when the manifest omits one. */
  keepWorkspaces?: 'never' | 'failed' | 'always'
  /** Include bounded stdout/stderr text in reports. Disabled by default. */
  includeProcessOutput?: boolean
  /** Emit lifecycle diagnostics without task or process content. */
  logLifecycle?: boolean
  /** Absolute probe output override. Normally supplied only by the evaluator child environment. */
  probeOutputPath?: string
}

export interface ResolvedConfig {
  readonly dshHome: string
  readonly reportsPath: string
  readonly runsPath: string
  readonly defaultTimeoutMs: number
  readonly defaultScorerTimeoutMs: number
  readonly maxOutputBytes: number
  readonly maxConcurrency: number
  readonly maxWorkspaceEntries: number
  readonly maxWorkspaceBytes: number
  readonly maxAssertionBytes: number
  readonly keepWorkspaces: 'never' | 'failed' | 'always'
  readonly includeProcessOutput: boolean
  readonly logLifecycle: boolean
  readonly probeOutputPath: string | undefined
}

export const ConfigSchema = z.object({
  dshHome: z.string().default(undefined as unknown as string),
  reportsPath: z.string().default(undefined as unknown as string),
  runsPath: z.string().default(undefined as unknown as string),
  defaultTimeoutMs: z.number().step(1).min(100).max(86_400_000).default(300_000),
  defaultScorerTimeoutMs: z.number().step(1).min(100).max(3_600_000).default(30_000),
  maxOutputBytes: z.number().step(1).min(1_024).max(100_000_000).default(1_000_000),
  maxConcurrency: z.number().step(1).min(1).max(16).default(1),
  maxWorkspaceEntries: z.number().step(1).min(1).max(1_000_000).default(20_000),
  maxWorkspaceBytes: z.number().step(1).min(1_024).max(10_000_000_000).default(268_435_456),
  maxAssertionBytes: z.number().step(1).min(1).max(100_000_000).default(10_000_000),
  keepWorkspaces: z.union(['never', 'failed', 'always']).default('never'),
  includeProcessOutput: z.boolean().default(false),
  logLifecycle: z.boolean().default(false),
  probeOutputPath: z.string().default(undefined as unknown as string),
}) as z<Config>

const CONFIG_KEYS = new Set([
  'dshHome',
  'reportsPath',
  'runsPath',
  'defaultTimeoutMs',
  'defaultScorerTimeoutMs',
  'maxOutputBytes',
  'maxConcurrency',
  'maxWorkspaceEntries',
  'maxWorkspaceBytes',
  'maxAssertionBytes',
  'keepWorkspaces',
  'includeProcessOutput',
  'logLifecycle',
  'probeOutputPath',
])

/** Resolve defaults and cross-field constraints before opening any resource. */
export function resolveConfig(config: Config = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  assertPlainObject(config, 'dsh-eval config')
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-eval config: unknown key "${key}"`)
  }
  for (const key of ['dshHome', 'reportsPath', 'runsPath', 'probeOutputPath'] as const) {
    const value = config[key]
    if (value !== undefined && typeof value !== 'string') throw new Error(`dsh-eval config.${key} must be a string`)
    if (value !== undefined && !isAbsolute(value)) throw new Error(`dsh-eval config.${key} must be an absolute path`)
  }
  for (const key of ['includeProcessOutput', 'logLifecycle'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') {
      throw new Error(`dsh-eval config.${key} must be a boolean`)
    }
  }
  if (config.keepWorkspaces !== undefined && !['never', 'failed', 'always'].includes(config.keepWorkspaces)) {
    throw new Error('dsh-eval config.keepWorkspaces is invalid')
  }

  const dshHome = resolve(config.dshHome ?? env['DSH_HOME'] ?? join(homedir(), '.dsh'))
  const reportsPath = resolve(config.reportsPath ?? join(dshHome, 'eval', 'v1', 'reports'))
  const runsPath = resolve(config.runsPath ?? join(dshHome, 'eval', 'v1', 'runs'))
  const resolved: ResolvedConfig = Object.freeze({
    dshHome,
    reportsPath,
    runsPath,
    defaultTimeoutMs: config.defaultTimeoutMs ?? 300_000,
    defaultScorerTimeoutMs: config.defaultScorerTimeoutMs ?? 30_000,
    maxOutputBytes: config.maxOutputBytes ?? 1_000_000,
    maxConcurrency: config.maxConcurrency ?? 1,
    maxWorkspaceEntries: config.maxWorkspaceEntries ?? 20_000,
    maxWorkspaceBytes: config.maxWorkspaceBytes ?? 268_435_456,
    maxAssertionBytes: config.maxAssertionBytes ?? 10_000_000,
    keepWorkspaces: config.keepWorkspaces ?? 'never',
    includeProcessOutput: config.includeProcessOutput ?? false,
    logLifecycle: config.logLifecycle ?? false,
    probeOutputPath: config.probeOutputPath ?? env['DSH_EVAL_PROBE_TOKEN_FILE'],
  })
  assertInteger('defaultTimeoutMs', resolved.defaultTimeoutMs, 100, 86_400_000)
  assertInteger('defaultScorerTimeoutMs', resolved.defaultScorerTimeoutMs, 100, 3_600_000)
  assertInteger('maxOutputBytes', resolved.maxOutputBytes, 1_024, 100_000_000)
  assertInteger('maxConcurrency', resolved.maxConcurrency, 1, 16)
  assertInteger('maxWorkspaceEntries', resolved.maxWorkspaceEntries, 1, 1_000_000)
  assertInteger('maxWorkspaceBytes', resolved.maxWorkspaceBytes, 1_024, 10_000_000_000)
  assertInteger('maxAssertionBytes', resolved.maxAssertionBytes, 1, 100_000_000)
  if (resolved.reportsPath === resolved.runsPath) {
    throw new Error('dsh-eval config.reportsPath and runsPath must be different directories')
  }
  return resolved
}

function assertPlainObject(value: unknown, name: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
}

function assertInteger(name: string, value: unknown, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-eval config.${name} must be an integer in [${minimum}, ${maximum}]`)
  }
}
