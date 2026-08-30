import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { JsonValue } from './types.ts'

/** Signals mutation of evaluator-controlled input; callers must never turn this into a candidate score. */
export class InputIntegrityError extends Error {
  constructor(message: string) {
    super(`dsh-eval input integrity failure: ${message}`)
    this.name = 'InputIntegrityError'
  }
}

/** Deterministic JSON encoding used for immutable input and report hashes. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('dsh-eval canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(',')}}`
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Resolve an untrusted relative path and prove it remains beneath `base`. */
export function resolveInside(base: string, input: string, label: string): string {
  if (input.length === 0 || isAbsolute(input)) throw new Error(`${label} must be a non-empty relative path`)
  const target = resolve(base, input)
  assertInside(base, target, label)
  return target
}

/** Prove an already-resolved target remains beneath `base`. */
export function assertInside(base: string, target: string, label: string): void {
  const relation = relative(resolve(base), target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes its owning directory`)
  }
}

export interface TreeDigest {
  readonly sha256: string
  readonly entries: readonly {
    readonly path: string
    readonly type: 'file' | 'directory'
    readonly sha256?: string
    readonly bytes?: number
  }[]
}

/** Hash a fixture without following symlinks, which are rejected at the trust boundary. */
export async function digestTree(root: string, label: string): Promise<TreeDigest> {
  const entries: Array<{ path: string; type: 'file' | 'directory'; sha256?: string; bytes?: number }> = []
  const rootStat = await lstat(root).catch(error => {
    throw new Error(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (rootStat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  if (rootStat.isFile()) {
    const bytes = await readFile(root)
    entries.push({ path: '.', type: 'file', sha256: sha256(bytes), bytes: bytes.byteLength })
  } else if (rootStat.isDirectory()) {
    await visit(root, '')
  } else {
    throw new Error(`${label} must be a file or directory`)
  }

  const encoded = canonicalJson(entries.map(entry => ({
    path: entry.path,
    type: entry.type,
    ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
  })) as JsonValue)
  return Object.freeze({ sha256: sha256(encoded), entries: Object.freeze(entries.map(entry => Object.freeze(entry))) })

  async function visit(directory: string, prefix: string): Promise<void> {
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right, 'en'))
    for (const name of names) {
      const absolute = resolve(directory, name)
      const path = prefix.length === 0 ? name : `${prefix}/${name}`
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error(`${label} contains forbidden symbolic link: ${path}`)
      if (stat.isDirectory()) {
        entries.push({ path, type: 'directory' })
        await visit(absolute, path)
      } else if (stat.isFile()) {
        const bytes = await readFile(absolute)
        entries.push({ path, type: 'file', sha256: sha256(bytes), bytes: bytes.byteLength })
      } else {
        throw new Error(`${label} contains unsupported entry: ${path}`)
      }
    }
  }
}
