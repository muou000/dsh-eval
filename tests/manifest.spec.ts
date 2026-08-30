import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadManifest } from '../src/manifest.ts'
import { writeTestSuite } from './helpers.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('loadManifest', () => {
  it('pins manifest, dataset, fixture, and scorer identities', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-manifest-'))
    const path = await writeTestSuite(root)
    const first = await loadManifest(path)
    const second = await loadManifest(path)
    expect(first.manifestHash).toBe(second.manifestHash)
    expect(first.datasetHash).toBe(second.datasetHash)
    expect(first.scorerHash).toBe(second.scorerHash)
    expect(first.cases[0]?.fixtureSha256).toMatch(/^[a-f0-9]{64}$/)

    await writeFile(join(root, 'scorers', 'verify.mjs'), 'process.exitCode = 0\n', 'utf8')
    const changed = await loadManifest(path)
    expect(changed.manifestHash).toBe(first.manifestHash)
    expect(changed.datasetHash).toBe(first.datasetHash)
    expect(changed.scorerHash).not.toBe(first.scorerHash)
  })

  it('rejects a fixture that escapes the manifest root', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-manifest-'))
    const path = await writeTestSuite(root)
    const casePath = join(root, 'cases', 'one.json')
    const evalCase = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(casePath, 'utf8'))) as Record<string, unknown>
    evalCase['fixture'] = '../../../outside'
    await writeFile(casePath, JSON.stringify(evalCase), 'utf8')
    await expect(loadManifest(path)).rejects.toThrow('escapes')
  })

  it('requires the declared entry artifact to be the launched program', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-manifest-'))
    const path = await writeTestSuite(root)
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      variants: Record<'baseline' | 'candidate', { artifacts: string[]; entryArtifact: string }>
    }
    for (const role of ['baseline', 'candidate'] as const) {
      manifest.variants[role].artifacts.push('scorers/verify.mjs')
      manifest.variants[role].entryArtifact = 'scorers/verify.mjs'
    }
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await expect(loadManifest(path)).rejects.toThrow('must resolve to the executable or one literal argv entry')
  })
})
