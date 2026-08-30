import { copyFile, lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import { expandPlaceholders, safeScorerEnvironment } from './environment.ts'
import { canonicalJson, digestTree, InputIntegrityError, sha256 } from './integrity.ts'
import { runProcess } from './process-runner.ts'
import type {
  AssertionResult,
  EvalAssertion,
  JsonValue,
  LoadedEvalCase,
  ProcessOutcome,
} from './types.ts'
import { cloneWorkspaceForScorer, resolveWorkspaceEntry } from './workspace.ts'

export interface ScoredRun {
  readonly success: boolean
  readonly score: number
  readonly assertions: readonly AssertionResult[]
}

/** Score only evaluator-controlled facts after the candidate process has settled. */
export async function scoreRun(
  evalCase: LoadedEvalCase,
  workspace: string,
  process: ProcessOutcome,
  config: ResolvedConfig,
  scorerTimeoutMs: number,
  signal?: AbortSignal,
): Promise<ScoredRun> {
  const expectedExitCode = evalCase.expectedExitCode ?? 0
  const exitPassed = process.exitCode === expectedExitCode
    && process.spawnError === undefined
    && !process.timedOut
    && !process.aborted
  const results: AssertionResult[] = [Object.freeze({
    id: 'process-exit',
    kind: 'process-exit',
    category: 'stability',
    required: true,
    weight: 0,
    passed: exitPassed,
    message: `expected=${expectedExitCode} actual=${process.exitCode ?? 'null'} timed_out=${process.timedOut} aborted=${process.aborted} spawn_error=${process.spawnError ?? 'none'}`,
  })]
  for (const assertion of evalCase.assertions) {
    results.push(await evaluateAssertion(assertion, evalCase, workspace, config, scorerTimeoutMs, signal))
  }
  const requiredPassed = results.every(result => !result.required || result.passed)
  const weighted = results.filter(result => result.weight > 0)
  const denominator = weighted.reduce((sum, result) => sum + result.weight, 0)
  const numerator = weighted.reduce((sum, result) => sum + (result.passed ? result.weight : 0), 0)
  return Object.freeze({
    success: requiredPassed,
    score: denominator === 0 ? (requiredPassed ? 1 : 0) : numerator / denominator,
    assertions: Object.freeze(results),
  })
}

async function evaluateAssertion(
  assertion: EvalAssertion,
  evalCase: LoadedEvalCase,
  workspace: string,
  config: ResolvedConfig,
  scorerTimeoutMs: number,
  signal?: AbortSignal,
): Promise<AssertionResult> {
  const common = {
    id: assertion.id,
    kind: assertion.kind,
    category: assertion.category ?? 'quality',
    required: assertion.required ?? true,
    weight: assertion.weight ?? 1,
  } as const
  try {
    if (assertion.kind === 'file-exists') {
      const path = await resolveWorkspaceEntry(workspace, assertion.path, assertion.entryType === 'symlink')
      const stat = await lstat(path).catch(error => missingAsUndefined(error))
      const actual = stat === undefined ? 'missing' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other'
      const passed = stat !== undefined && (assertion.entryType === undefined || actual === assertion.entryType)
      return Object.freeze({ ...common, passed, message: `expected=${assertion.entryType ?? 'any'} actual=${actual}` })
    }
    if (assertion.kind === 'file-absent') {
      const path = await resolveWorkspaceEntry(workspace, assertion.path, true)
      const stat = await lstat(path).catch(error => missingAsUndefined(error))
      return Object.freeze({ ...common, passed: stat === undefined, message: stat === undefined ? 'entry is absent' : 'entry exists' })
    }
    if (assertion.kind === 'file-content') {
      const path = await resolveWorkspaceEntry(workspace, assertion.path)
      const bytes = await readBounded(path, config.maxAssertionBytes)
      const actualSha256 = sha256(bytes)
      const actual = bytes.toString('utf8')
      let passed: boolean
      if (assertion.operator === 'equals') passed = actual === assertion.expected
      else if (assertion.operator === 'contains') passed = actual.includes(assertion.expected)
      else if (assertion.operator === 'matches') passed = new RegExp(assertion.expected, assertion.flags).test(actual)
      else passed = actualSha256 === assertion.expected
      return Object.freeze({
        ...common,
        passed,
        message: `operator=${assertion.operator} bytes=${bytes.byteLength}`,
        actualSha256,
      })
    }
    if (assertion.kind === 'json-value') {
      const path = await resolveWorkspaceEntry(workspace, assertion.path)
      const bytes = await readBounded(path, config.maxAssertionBytes)
      const actualSha256 = sha256(bytes)
      const document = JSON.parse(bytes.toString('utf8')) as JsonValue
      const selected = selectJsonPointer(document, assertion.pointer)
      const passed = assertion.operator === 'exists'
        ? selected !== MISSING
        : assertion.operator === 'not-exists'
          ? selected === MISSING
          : selected !== MISSING && canonicalJson(selected) === canonicalJson(assertion.expected as JsonValue)
      return Object.freeze({
        ...common,
        passed,
        message: `operator=${assertion.operator} pointer_found=${selected !== MISSING}`,
        actualSha256,
      })
    }
    return await evaluateTrustedScript(assertion, evalCase, workspace, config, scorerTimeoutMs, signal, common)
  } catch (error) {
    if (error instanceof InputIntegrityError) throw error
    return Object.freeze({ ...common, passed: false, message: `scorer_error=${sanitizeScorerError(error)}` })
  }
}

async function evaluateTrustedScript(
  assertion: Extract<EvalAssertion, { kind: 'trusted-script' }>,
  evalCase: LoadedEvalCase,
  workspace: string,
  config: ResolvedConfig,
  scorerTimeoutMs: number,
  signal: AbortSignal | undefined,
  common: Pick<AssertionResult, 'id' | 'kind' | 'category' | 'required' | 'weight'>,
): Promise<AssertionResult> {
  const scriptPath = resolve(evalCase.sourceDirectory, assertion.script)
  const digest = await digestTree(scriptPath, `trusted scorer ${assertion.id}`)
  if (digest.sha256 !== evalCase.trustedScriptSha256[assertion.id]) {
    throw new InputIntegrityError(`trusted scorer ${assertion.id} changed after manifest load`)
  }
  const clone = await cloneWorkspaceForScorer(workspace)
  try {
    const scorerSnapshot = join(dirname(clone.path), 'trusted-scorer.mjs')
    await copyFile(scriptPath, scorerSnapshot)
    const snapshotDigest = await digestTree(scorerSnapshot, `trusted scorer ${assertion.id} snapshot`)
    if (snapshotDigest.sha256 !== evalCase.trustedScriptSha256[assertion.id]) {
      throw new InputIntegrityError(`trusted scorer ${assertion.id} changed while it was copied`)
    }
    const context = { workspace: clone.path, manifestDirectory: evalCase.sourceDirectory }
    const outcome = await runProcess({
      executable: process.execPath,
      args: [scorerSnapshot, ...(assertion.args ?? []).map(arg => expandPlaceholders(arg, context))],
      cwd: clone.path,
      env: safeScorerEnvironment(clone.path),
      timeoutMs: scorerTimeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      includeOutput: false,
      ...(signal === undefined ? {} : { signal }),
    })
    const expected = assertion.expectedExitCode ?? 0
    const passed = outcome.exitCode === expected && !outcome.timedOut && !outcome.aborted && outcome.spawnError === undefined
    return Object.freeze({
      ...common,
      passed,
      message: `expected=${expected} actual=${outcome.exitCode ?? 'null'} timed_out=${outcome.timedOut} stdout_sha256=${outcome.stdoutSha256}`,
    })
  } finally {
    await clone.dispose()
  }
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const stat = await lstat(path)
  if (!stat.isFile()) throw new Error('asserted entry is not a regular file')
  if (stat.size > maximum) throw new Error(`asserted file exceeds ${maximum} bytes`)
  const bytes = await readFile(path)
  if (bytes.byteLength > maximum) throw new Error(`asserted file exceeds ${maximum} bytes`)
  return bytes
}

function missingAsUndefined(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
  throw error
}

const MISSING = Symbol('missing')

function selectJsonPointer(document: JsonValue, pointer: string): JsonValue | typeof MISSING {
  if (pointer.length === 0) return document
  let current: JsonValue = document
  for (const encoded of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(encoded)) throw new Error('invalid JSON Pointer escape')
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~')
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return MISSING
    current = (current as Record<string, JsonValue>)[key] as JsonValue
  }
  return current
}

function sanitizeScorerError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  return error.message.replace(/[\r\n]+/g, ' ').slice(0, 512)
}
