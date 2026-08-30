import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import type { ProcessOutcome } from './types.ts'

export interface ProcessRunOptions {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdin?: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly includeOutput: boolean
  readonly signal?: AbortSignal
}

/** Spawn without a shell and preserve timeout, abort, exit, signal, and spawn-error facts independently. */
export async function runProcess(options: ProcessRunOptions): Promise<ProcessOutcome> {
  const started = performance.now()
  if (options.signal?.aborted === true) {
    return emptyOutcome(performance.now() - started, true)
  }

  return await new Promise<ProcessOutcome>(resolve => {
    let timedOut = false
    let aborted = false
    let spawnError: string | undefined
    let settled = false
    const stdout = new BoundedCapture(options.maxOutputBytes)
    const stderr = new BoundedCapture(options.maxOutputBytes)
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer | string) => stdout.add(chunk))
    child.stderr.on('data', (chunk: Buffer | string) => stderr.add(chunk))
    child.on('error', error => { spawnError = sanitizeError(error) })
    child.on('close', (exitCode, signal) => settle(exitCode, signal))

    const timeout = setTimeout(() => {
      timedOut = true
      terminateOwnedProcess(child.pid)
    }, options.timeoutMs)
    timeout.unref()

    const onAbort = (): void => {
      aborted = true
      terminateOwnedProcess(child.pid)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin)

    function settle(exitCode: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      const stdoutResult = stdout.finish(options.includeOutput)
      const stderrResult = stderr.finish(options.includeOutput)
      resolve(Object.freeze({
        exitCode,
        signal,
        timedOut,
        aborted,
        ...(spawnError === undefined ? {} : { spawnError }),
        durationMs: performance.now() - started,
        stdoutBytes: stdoutResult.bytes,
        stderrBytes: stderrResult.bytes,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
        stdoutSha256: stdoutResult.sha256,
        stderrSha256: stderrResult.sha256,
        ...(stdoutResult.text === undefined ? {} : { stdout: stdoutResult.text }),
        ...(stderrResult.text === undefined ? {} : { stderr: stderrResult.text }),
      }))
    }
  })
}

class BoundedCapture {
  private readonly chunks: Buffer[] = []
  private readonly hash = createHash('sha256')
  private capturedBytes = 0
  private totalBytes = 0

  constructor(private readonly maximum: number) {}

  add(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.totalBytes += bytes.byteLength
    this.hash.update(bytes)
    if (this.capturedBytes >= this.maximum) return
    const remaining = this.maximum - this.capturedBytes
    const captured = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining)
    this.chunks.push(captured)
    this.capturedBytes += captured.byteLength
  }

  finish(includeText: boolean): { bytes: number; truncated: boolean; sha256: string; text?: string } {
    const bytes = Buffer.concat(this.chunks)
    return {
      bytes: this.totalBytes,
      truncated: this.totalBytes > this.capturedBytes,
      sha256: this.hash.digest('hex'),
      ...(includeText ? { text: bytes.toString('utf8') } : {}),
    }
  }
}

function terminateOwnedProcess(pid: number | undefined): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    })
    killer.on('error', () => undefined)
    return
  }
  try { process.kill(-pid, 'SIGTERM') } catch { return }
  const force = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ }
  }, 1_000)
  force.unref()
}

function emptyOutcome(durationMs: number, aborted: boolean): ProcessOutcome {
  const emptyHash = createHash('sha256').update('').digest('hex')
  return Object.freeze({
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted,
    durationMs,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutSha256: emptyHash,
    stderrSha256: emptyHash,
  })
}

function sanitizeError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code
  return code === undefined ? error.name : `${error.name}:${code}`
}
