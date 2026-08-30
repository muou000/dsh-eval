import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { Evaluator } from '../src/evaluator.ts'
import { loadManifest } from '../src/manifest.ts'
import { writeTestSuite } from './helpers.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Evaluator', () => {
  it('runs paired counterbalanced observations and publishes external-world evidence', { timeout: 30_000 }, async () => {
    const root = await temporaryRoot()
    const manifestPath = await writeTestSuite(root)
    const output = join(root, 'reports', 'latest.json')
    const config = resolveConfig({
      dshHome: join(root, 'home'),
      reportsPath: join(root, 'reports'),
      runsPath: join(root, 'runs'),
    }, {})
    const evaluator = new Evaluator(config)
    const report = await evaluator.run(manifestPath, { outputPath: output })
    await evaluator.dispose()

    expect(report.decision).toBe('pass')
    expect(report.baseline).toMatchObject({ runs: 5, successes: 0, successRate: 0 })
    expect(report.candidate).toMatchObject({ runs: 5, successes: 5, successRate: 1 })
    expect(report.paired).toMatchObject({ pairs: 5, candidateImproved: 5, candidateRegressed: 0, candidateTaskRegressed: 0, successRateDelta: 1 })
    expect(report.runs.map(run => run.role)).toEqual([
      'candidate', 'baseline', 'baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate', 'candidate', 'baseline',
    ])
    expect(report.assurance).toBe('local-trusted-process')
    expect(report.promotionEligible).toBe(false)
    expect(report.evaluatorArtifactSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(report.runs.every(run => run.workspaceChanges.some(change => change.path === 'answer.txt'))).toBe(true)
    expect(report.runs.every(run => run.process.stdout === undefined && run.process.stderr === undefined)).toBe(true)
    expect(report.runs.some(run => run.retainedWorkspace !== undefined)).toBe(false)
    expect(await readdir(config.runsPath)).toEqual([])
    const persisted = JSON.parse(await readFile(output, 'utf8')) as { decision: string; datasetHash: string }
    expect(persisted.decision).toBe('pass')
    expect(persisted.datasetHash).toBe(report.datasetHash)
    expect(await readFile(output.replace(/\.json$/, '.md'), 'utf8')).toContain('Decision: **PASS**')
  })

  it('fails closed when a loaded fixture changes before execution', async () => {
    const root = await temporaryRoot()
    const manifestPath = await writeTestSuite(root)
    const loaded = await loadManifest(manifestPath)
    await writeFile(join(root, 'fixtures', 'one', 'input.txt'), 'tampered\n', 'utf8')
    const evaluator = new Evaluator(resolveConfig({
      dshHome: join(root, 'home'),
      reportsPath: join(root, 'reports'),
      runsPath: join(root, 'runs'),
    }, {}))
    await expect(evaluator.run(loaded)).rejects.toThrow('input integrity failure')
    await evaluator.dispose()
    expect(await readdir(join(root, 'runs'))).toEqual([])
  })

  it('aborts without publishing a decision when a trusted scorer changes', async () => {
    const root = await temporaryRoot()
    const manifestPath = await writeTestSuite(root)
    const loaded = await loadManifest(manifestPath)
    await writeFile(join(root, 'scorers', 'verify.mjs'), 'process.exitCode = 0\n', 'utf8')
    const reportsPath = join(root, 'reports')
    const evaluator = new Evaluator(resolveConfig({
      dshHome: join(root, 'home'),
      reportsPath,
      runsPath: join(root, 'runs'),
    }, {}))
    await expect(evaluator.run(loaded)).rejects.toMatchObject({ name: 'InputIntegrityError' })
    await evaluator.dispose()
    expect(await readdir(reportsPath).catch(() => [])).toEqual([])
  })

  it('detects a candidate that mutates its content-addressed execution snapshot', async () => {
    const root = await temporaryRoot()
    const manifestPath = await writeTestSuite(root)
    await writeFile(join(root, 'runners', 'run.mjs'), [
      "import { appendFile, writeFile } from 'node:fs/promises'",
      "import { fileURLToPath } from 'node:url'",
      "await writeFile('answer.txt', '42\\n', 'utf8')",
      "await writeFile('run.json', JSON.stringify({ task: process.argv[2] }), 'utf8')",
      "await appendFile(fileURLToPath(import.meta.url), '\\n// changed during run\\n', 'utf8')",
      '',
    ].join('\n'), 'utf8')
    const reportsPath = join(root, 'reports')
    const evaluator = new Evaluator(resolveConfig({
      dshHome: join(root, 'home'),
      reportsPath,
      runsPath: join(root, 'runs'),
    }, {}))
    await expect(evaluator.run(manifestPath)).rejects.toMatchObject({ name: 'InputIntegrityError' })
    await evaluator.dispose()
    expect(await readdir(reportsPath).catch(() => [])).toEqual([])
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-eval-test-'))
  roots.push(root)
  return root
}
