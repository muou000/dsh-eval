import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { Evaluator } from '../src/evaluator.ts'
import { writeTestSuite } from './helpers.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Evaluator lifecycle', () => {
  it('cancels the process tree, waits for settlement, and removes owned workspaces on dispose', { timeout: 20_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-lifecycle-'))
    const manifest = await writeTestSuite(root, { hanging: true })
    const runsPath = join(root, 'runs')
    const evaluator = new Evaluator(resolveConfig({
      dshHome: join(root, 'home'),
      reportsPath: join(root, 'reports'),
      runsPath,
    }, {}))
    const pending = evaluator.run(manifest)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await waitForEntry(runsPath)
    await evaluator.dispose()
    await rejected
    expect(await readdir(runsPath)).toEqual([])
    await expect(evaluator.run(manifest)).rejects.toThrow('disposed')
  })
})

async function waitForEntry(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const entries = await readdir(path).catch(() => [])
    if (entries.length > 0) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for evaluator workspace')
}
