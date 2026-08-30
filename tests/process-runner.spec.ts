import { describe, expect, it } from 'vitest'
import { runProcess } from '../src/process-runner.ts'

const base = {
  executable: process.execPath,
  cwd: process.cwd(),
  env: { PATH: process.env.PATH },
  timeoutMs: 5_000,
  maxOutputBytes: 1_024,
  includeOutput: true,
} as const

describe('runProcess', () => {
  it('bounds retained output while hashing and counting the complete streams', async () => {
    const outcome = await runProcess({ ...base, args: ['-e', "process.stdout.write('x'.repeat(4096)); process.stderr.write('err')"] })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.aborted).toBe(false)
    expect(outcome.stdoutBytes).toBe(4_096)
    expect(outcome.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(outcome.stdout ?? '')).toBe(1_024)
    expect(outcome.stderr).toBe('err')
    expect(outcome.stdoutSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('records timeout separately from the eventual process exit', { timeout: 15_000 }, async () => {
    const outcome = await runProcess({ ...base, args: ['-e', 'setInterval(() => undefined, 1000)'], timeoutMs: 100 })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.aborted).toBe(false)
    expect(outcome.exitCode === null || outcome.exitCode !== 0).toBe(true)
  })

  it('owns external cancellation and reports it independently', { timeout: 15_000 }, async () => {
    const controller = new AbortController()
    const promise = runProcess({ ...base, args: ['-e', 'setInterval(() => undefined, 1000)'], signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const outcome = await promise
    expect(outcome.aborted).toBe(true)
    expect(outcome.timedOut).toBe(false)
  })

  it('contains executable lookup failures as process facts', async () => {
    const outcome = await runProcess({ ...base, executable: 'definitely-not-a-real-dsh-eval-command', args: [] })
    expect(outcome.exitCode === null || outcome.exitCode !== 0).toBe(true)
    expect(outcome.spawnError).toContain('ENOENT')
  })
})
