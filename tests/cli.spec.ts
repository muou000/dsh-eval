import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli, type CliSignalSource } from '../src/cli.ts'
import { writeTestSuite } from './helpers.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('dsh-eval CLI', () => {
  it('validates the packaged example and reports immutable input identities', async () => {
    let stdout = ''
    let stderr = ''
    const code = await runCli(['validate', resolve('examples', 'manifest.json')], {
      stdout: text => { stdout += text },
      stderr: text => { stderr += text },
    })
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toMatchObject({ valid: true, manifestId: 'keyless-smoke', cases: 1 })
  })

  it('returns a stable error without throwing or exiting the host process', async () => {
    let stderr = ''
    const code = await runCli(['unknown'], { stdout: () => undefined, stderr: text => { stderr += text } })
    expect(code).toBe(1)
    expect(stderr).toContain('unknown command')
  })

  it('turns repeated termination signals into one abort and waits for cleanup', { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-eval-cli-'))
    roots.push(root)
    const manifest = await writeTestSuite(root, { hanging: true })
    const runsPath = join(root, 'runs')
    const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>()
    const signals: CliSignalSource = {
      on: (signal, listener) => { listeners.set(signal, listener) },
      off: signal => { listeners.delete(signal) },
    }
    let stderr = ''
    const pending = runCli([
      'run', manifest,
      '--reports-path', join(root, 'reports'),
      '--runs-path', runsPath,
    ], { stdout: () => undefined, stderr: text => { stderr += text } }, signals)
    await waitFor(() => listeners.has('SIGINT'))
    listeners.get('SIGINT')?.()
    listeners.get('SIGINT')?.()
    expect(await pending).toBe(130)
    expect(stderr).toContain('interrupted by SIGINT')
    expect(listeners.size).toBe(0)
    expect(await readdir(runsPath).catch(() => [])).toEqual([])
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}
