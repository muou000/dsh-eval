import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const options = parseArgs(process.argv.slice(2))
const pluginRoot = resolve(import.meta.dirname, '..')
const dshRoot = resolve(options.dshRoot)
const dshDirty = gitDirty(dshRoot)
if (dshDirty) throw new Error('current DSH smoke requires a clean upstream checkout')

const [cordis, llm, sessionModule, evaluation] = await Promise.all([
  import(pathToFileURL(join(dshRoot, 'vendor', 'cordis', 'lib', 'index.js')).href),
  import(pathToFileURL(join(dshRoot, 'packages', 'llm', 'llm', 'lib', 'index.js')).href),
  import(pathToFileURL(join(dshRoot, 'packages', 'core', 'session', 'lib', 'index.js')).href),
  import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href),
])
const { Context } = cordis
const SessionStore = sessionModule.default
const root = await mkdtemp(join(tmpdir(), 'dsh-eval-current-dsh-'))
const probePath = join(root, 'probe.json')
const context = new Context()
const environment = saveEnvironment(['DSH_EVAL_RUN_ID', 'DSH_EVAL_CASE_ID', 'DSH_EVAL_VARIANT'])
const checks = {
  serviceLoaded: false,
  currentSessionEventsObserved: false,
  usageObserved: false,
  probeContentFree: false,
  evaluatorDisposed: false,
}
let service

try {
  process.env.DSH_EVAL_RUN_ID = 'current-dsh-smoke'
  process.env.DSH_EVAL_CASE_ID = 'probe-compatibility'
  process.env.DSH_EVAL_VARIANT = 'candidate'
  await context.plugin(SessionStore)
  await context.plugin(evaluation, { dshHome: root, probeOutputPath: probePath })
  service = context.get('evals')
  checks.serviceLoaded = service !== undefined

  const session = context.sessions.create(sessionModule.SessionId('dsh-eval-current-smoke'))
  const callId = llm.ToolCallId('dsh-eval-current-call')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: llm.createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'PRIVATE-PROBE-MARKER' }],
      source: { kind: 'model', provider: 'current-dsh-smoke', model: 'deterministic' },
    }),
    usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'smoke', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: llm.createToolResultMessage({ callId, content: [], isError: true }),
    error: { name: 'Error', code: 'CURRENT_DSH_SMOKE' },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await context.sessions.flush(session)

  const metrics = evaluation.readProbeMetrics(probePath, {
    runId: 'current-dsh-smoke', caseId: 'probe-compatibility', variant: 'candidate',
  })
  checks.currentSessionEventsObserved = metrics?.sessions === 1
    && metrics.turns === 1
    && metrics.completedTurns === 1
    && metrics.modelCalls === 1
    && metrics.toolCalls === 1
    && metrics.toolErrors === 1
  checks.usageObserved = metrics?.inputTokens === 11
    && metrics.outputTokens === 5
    && metrics.cacheReadTokens === 3
    && metrics.cacheWriteTokens === 2
    && metrics.totalTokens === 21
  checks.probeContentFree = !(await readFile(probePath, 'utf8')).includes('PRIVATE-PROBE-MARKER')
} finally {
  await context.fiber.dispose()
  if (service !== undefined) {
    try {
      await service.run(join(root, 'missing-manifest.json'))
    } catch (error) {
      checks.evaluatorDisposed = error instanceof Error && error.message.includes('disposed')
    }
  }
  restoreEnvironment(environment)
  await rm(root, { recursive: true, force: true })
}

const report = {
  format: 'dsh-eval-current-dsh-smoke',
  version: 1,
  pluginRevision: gitRevision(pluginRoot),
  pluginDirty: gitDirty(pluginRoot, ['evals/reports/**']),
  dshRevision: gitRevision(dshRoot),
  dshDirty,
  dshSessionVersion: JSON.parse(await readFile(join(dshRoot, 'packages', 'core', 'session', 'package.json'), 'utf8')).version,
  node: process.version,
  assurance: 'self-reported-probe-compatibility-only',
  checks,
  pass: Object.values(checks).every(Boolean),
}
await mkdir(dirname(options.output), { recursive: true })
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1

function parseArgs(argv) {
  let dshRoot = process.env.DSH_ROOT
  let output = join(resolve(import.meta.dirname, '..'), 'evals', 'reports', 'current-dsh-smoke-latest.json')
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--dsh-root') {
      dshRoot = argv[index + 1]
      index += 1
    } else if (argument === '--output') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--output requires a path')
      output = isAbsolute(value) ? value : resolve(value)
      index += 1
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  if (dshRoot === undefined) throw new Error('--dsh-root or DSH_ROOT is required')
  return { dshRoot, output }
}

function gitRevision(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function gitDirty(root, exclusions = []) {
  const args = ['status', '--porcelain', '--untracked-files=all', '--', '.', ...exclusions.map(value => `:(exclude)${value}`)]
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim().length > 0
}

function saveEnvironment(names) {
  return new Map(names.map(name => [name, process.env[name]]))
}

function restoreEnvironment(saved) {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
