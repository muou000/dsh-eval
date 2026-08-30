import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const output = process.env.DSH_EVAL_PACK_OUTPUT ?? 'evals/reports/pack-smoke-latest.json'
const root = await mkdtemp(join(tmpdir(), 'dsh-eval-pack-'))
const packDirectory = join(root, 'packages')
const consumer = join(root, 'consumer')
const checks = {}
let report
const sourceRevision = process.env.DSH_EVAL_SOURCE_REVISION ?? git(['rev-parse', 'HEAD']).stdout.trim()
const sourceDirty = git([
  'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)evals/reports/**',
]).stdout.trim().length > 0

try {
  await mkdir(packDirectory, { recursive: true })
  runPnpm(['pack', '--pack-destination', packDirectory])
  const tarballs = (await readdir(packDirectory)).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`expected one packed tarball, found ${tarballs.length}`)
  const tarball = join(packDirectory, tarballs[0])
  const bytes = await readFile(tarball)
  checks.packProduced = bytes.length > 0

  await mkdir(consumer, { recursive: true })
  await writeFile(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'dsh-eval-pack-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      'dsh-eval': `file:${tarball.replaceAll('\\', '/')}`,
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-session': '0.1.1-rc.2',
    },
  }, null, 2)}\n`)
  runPnpm(['install', '--ignore-scripts', '--no-frozen-lockfile', '--registry=https://registry.npmjs.org'], consumer)
  checks.cleanInstallFromTarball = true

  const publicProbe = run(process.execPath, ['--input-type=module', '-e', [
    "const api = await import('dsh-eval')",
    "if (api.name !== 'dsh-eval' || typeof api.apply !== 'function' || typeof api.Evaluator !== 'function') process.exit(1)",
    "if (typeof api.loadManifest !== 'function' || typeof api.runProcess !== 'function') process.exit(1)",
  ].join(';')], consumer)
  checks.publicImport = publicProbe.status === 0
  if (!checks.publicImport) throw new Error(`public import probe failed: ${publicProbe.stderr.trim()}`)

  const helpProbe = runPnpm(['exec', 'dsh-eval', '--help'], consumer, false)
  checks.cliHelp = helpProbe.status === 0 && helpProbe.stdout.includes('dsh-eval validate')
  if (!checks.cliHelp) throw new Error(`CLI help probe failed: ${helpProbe.stderr.trim()}`)

  const example = join(consumer, 'node_modules', 'dsh-eval', 'examples', 'manifest.json')
  const validationProbe = runPnpm(['exec', 'dsh-eval', 'validate', example], consumer, false)
  checks.packagedExample = validationProbe.status === 0 && validationProbe.stdout.includes('keyless-smoke')
  if (!checks.packagedExample) throw new Error(`packaged example validation failed: ${validationProbe.stderr.trim()}`)

  const patch = await readFile(join(consumer, 'node_modules', 'dsh-eval', 'cordis.patch.yml'), 'utf8')
  checks.bundlePatch = patch.includes('id: dsh-eval') && patch.includes('name: dsh-eval')
  if (!checks.bundlePatch) throw new Error('packaged Cordis patch does not insert dsh-eval')

  const exampleReport = join(consumer, 'keyless-report.json')
  const executionProbe = runPnpm([
    'exec', 'dsh-eval', 'run', example, '--output', exampleReport, '--require-pass',
  ], consumer, false)
  const executed = executionProbe.status === 0
    ? JSON.parse(await readFile(exampleReport, 'utf8'))
    : undefined
  checks.packagedExampleExecution = executed?.decision === 'pass'
    && executed?.assurance === 'local-trusted-process'
    && executed?.promotionEligible === false
  if (!checks.packagedExampleExecution) throw new Error(`packaged example execution failed: ${executionProbe.stderr.trim()}`)

  const audit = runPnpm(['audit', '--prod', '--audit-level', 'high', '--registry=https://registry.npmjs.org'], consumer, false)
  checks.productionAudit = audit.status === 0
  if (!checks.productionAudit) throw new Error(`production dependency audit failed: ${audit.stdout.trim()} ${audit.stderr.trim()}`)

  const pass = Object.values(checks).every(Boolean)
  report = {
    schema: 'dsh-eval-pack-smoke',
    schemaVersion: 1,
    status: pass ? 'PASS' : 'FAIL',
    pass,
    releaseEligible: pass && !sourceDirty,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    package: tarballs[0].replace(/\.tgz$/, ''),
    tarballSha256: createHash('sha256').update(bytes).digest('hex'),
    tarballBytes: (await stat(tarball)).size,
    sourceRevision,
    sourceDirty,
    checks,
  }
} catch (error) {
  report = {
    schema: 'dsh-eval-pack-smoke',
    schemaVersion: 1,
    status: 'FAIL',
    pass: false,
    releaseEligible: false,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    checks,
    error: error instanceof Error ? error.message : String(error),
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (!report.releaseEligible) process.exitCode = 1

function runPnpm(args, cwd = resolve('.'), fail = true) {
  const result = process.platform === 'win32' ? runWindowsPnpm(args, cwd) : run('pnpm', args, cwd)
  if (fail && result.status !== 0) {
    throw new Error(`pnpm ${args[0]} failed with ${String(result.status)}: ${result.stdout.trim()} ${result.stderr.trim()}`)
  }
  return result
}

function runWindowsPnpm(args, cwd) {
  const pnpmHome = process.env.PNPM_HOME
  const executable = pnpmHome === undefined ? undefined : join(pnpmHome, '.tools', 'pnpm-exe', '10.33.0', 'pnpm.exe')
  if (executable !== undefined && existsSync(executable)) return run(executable, args, cwd)
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', ...args], cwd)
}

function git(args) {
  return run('git', args, resolve('.'))
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}
