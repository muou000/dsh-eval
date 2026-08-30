import { join } from 'node:path'
import type { EvalVariant } from './types.ts'

const SAFE_PARENT_NAMES = [
  'PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
] as const

const RESERVED_ENVIRONMENT_NAMES = new Set([
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'DSH_HOME', 'NODE_OPTIONS', 'NODE_PATH', 'PWD', 'OLDPWD',
])

/** Reserved names are compared case-insensitively so one manifest behaves safely on every host. */
export function isEvaluatorReservedEnvironmentName(name: string): boolean {
  const canonical = name.toUpperCase()
  return RESERVED_ENVIRONMENT_NAMES.has(canonical) || canonical.startsWith('DSH_EVAL_')
}

export interface ChildEnvironmentContext {
  readonly workspace: string
  readonly home: string
  readonly probeFile: string
  readonly runId: string
  readonly caseId: string
  readonly role: 'baseline' | 'candidate'
  readonly manifestDirectory: string
}

/** Build an isolated environment; parent secrets cross the boundary only by explicit name. */
export function buildChildEnvironment(variant: EvalVariant, context: ChildEnvironmentContext, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = safeParentEnvironment(parent)
  const temporary = join(context.home, 'tmp')
  Object.assign(env, {
    HOME: context.home,
    USERPROFILE: context.home,
    APPDATA: join(context.home, 'appdata'),
    LOCALAPPDATA: join(context.home, 'localappdata'),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    DSH_HOME: context.home,
    DSH_EVAL_PROBE_TOKEN_FILE: context.probeFile,
    DSH_EVAL_RUN_ID: context.runId,
    DSH_EVAL_CASE_ID: context.caseId,
    DSH_EVAL_VARIANT: context.role,
    DSH_EVAL_WORKSPACE: context.workspace,
  })
  for (const name of variant.inheritEnv ?? []) {
    if (isEvaluatorReservedEnvironmentName(name)) {
      throw new Error(`dsh-eval refuses to inherit evaluator-reserved environment variable ${name}`)
    }
    const actual = findEnvironmentName(parent, name)
    if (actual === undefined || parent[actual] === undefined) {
      throw new Error(`dsh-eval inherited environment variable ${name} is not set`)
    }
    env[name] = parent[actual]
  }
  for (const [name, value] of Object.entries(variant.env ?? {})) {
    if (isEvaluatorReservedEnvironmentName(name)) {
      throw new Error(`dsh-eval refuses to override evaluator-reserved environment variable ${name}`)
    }
    env[name] = expandPlaceholders(value, context)
  }
  return env
}

export function safeScorerEnvironment(workspace: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...safeParentEnvironment(parent),
    DSH_EVAL_WORKSPACE: workspace,
    HOME: workspace,
    USERPROFILE: workspace,
    TEMP: workspace,
    TMP: workspace,
    TMPDIR: workspace,
  }
}

export function materializeVariant(variant: EvalVariant, context: ChildEnvironmentContext, task: string): {
  executable: string
  args: readonly string[]
  stdin?: string
} {
  const executable = expandPlaceholders(variant.executable, context)
  const args = [...(variant.args ?? [])].map(value => expandPlaceholders(value, context))
  const input = variant.taskInput ?? 'argument'
  if (input === 'argument') args.push(task)
  return Object.freeze({
    executable,
    args: Object.freeze(args),
    ...(input === 'stdin' ? { stdin: task } : {}),
  })
}

export function expandPlaceholders(value: string, context: Pick<ChildEnvironmentContext, 'workspace' | 'manifestDirectory'>): string {
  return value
    .replaceAll('{workspace}', context.workspace)
    .replaceAll('{manifestDir}', context.manifestDirectory)
}

function safeParentEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const requested of SAFE_PARENT_NAMES) {
    const actual = findEnvironmentName(parent, requested)
    if (actual !== undefined && parent[actual] !== undefined) result[actual] = parent[actual]
  }
  return result
}

function findEnvironmentName(parent: NodeJS.ProcessEnv, requested: string): string | undefined {
  if (Object.hasOwn(parent, requested)) return requested
  if (process.platform !== 'win32') return undefined
  return Object.keys(parent).find(name => name.toLowerCase() === requested.toLowerCase())
}
