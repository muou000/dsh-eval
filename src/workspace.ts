import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import { canonicalJson, digestTree, InputIntegrityError, resolveInside, sha256 } from './integrity.ts'
import type { JsonValue, WorkspaceChange } from './types.ts'

export interface RunWorkspace {
  readonly root: string
  readonly workspace: string
  readonly home: string
  readonly probeFile: string
}

export interface VariantArtifactSnapshot {
  readonly directory: string
  assertUnchanged(): Promise<void>
}

interface SnapshotEntry {
  readonly type: 'file' | 'directory' | 'symlink'
  readonly sha256?: string
  readonly bytes?: number
  readonly target?: string
}

export interface WorkspaceSnapshot {
  readonly sha256: string
  readonly entries: ReadonlyMap<string, SnapshotEntry>
  readonly fileBytes: number
}

export async function createRunWorkspace(config: ResolvedConfig, fixturePath: string | undefined, fixtureSha256: string | undefined): Promise<RunWorkspace> {
  await mkdir(config.runsPath, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(config.runsPath, 'run-'))
  try {
    const workspace = join(root, 'workspace')
    const home = join(root, 'home')
    await mkdir(home, { mode: 0o700 })
    await Promise.all(['tmp', 'appdata', 'localappdata'].map(name => mkdir(join(home, name), { mode: 0o700 })))
    if (fixturePath !== undefined) {
      const digest = await digestTree(fixturePath, 'case fixture at run start')
      if (fixtureSha256 === undefined || digest.sha256 !== fixtureSha256) {
        throw new InputIntegrityError('case fixture changed after manifest load')
      }
      const stat = await lstat(fixturePath)
      if (!stat.isDirectory()) throw new Error('dsh-eval case fixture must be a directory')
      await cp(fixturePath, workspace, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
      const copied = await digestTree(workspace, 'copied case fixture')
      if (copied.sha256 !== fixtureSha256) throw new InputIntegrityError('case fixture changed while it was copied')
    } else {
      await mkdir(workspace, { mode: 0o700 })
    }
    return Object.freeze({ root, workspace, home, probeFile: join(root, 'probe.json') })
  } catch (error) {
    await removeOwnedRunPath(root, config.runsPath)
    throw error
  }
}

/** Copy only declared variant inputs into the run root, then execute from that content-checked snapshot. */
export async function snapshotVariantArtifacts(
  run: RunWorkspace,
  sourceDirectory: string,
  expectedHashes: Readonly<Record<string, string>>,
): Promise<VariantArtifactSnapshot> {
  const directory = join(run.root, 'variant-input')
  await mkdir(directory, { mode: 0o700 })
  for (const [artifact, expected] of Object.entries(expectedHashes)) {
    const source = resolveInside(sourceDirectory, artifact, 'variant artifact source')
    const target = resolveInside(directory, artifact, 'variant artifact snapshot')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    const actual = (await digestTree(target, `variant artifact snapshot ${artifact}`)).sha256
    if (actual !== expected) throw new InputIntegrityError(`variant artifact ${artifact} changed while it was copied`)
  }
  return Object.freeze({
    directory,
    async assertUnchanged(): Promise<void> {
      for (const [artifact, expected] of Object.entries(expectedHashes)) {
        const target = resolveInside(directory, artifact, 'variant artifact snapshot')
        const actual = (await digestTree(target, `variant artifact snapshot ${artifact}`)).sha256
        if (actual !== expected) throw new InputIntegrityError(`variant artifact snapshot ${artifact} changed during execution`)
      }
    },
  })
}

export async function snapshotWorkspace(workspace: string, config: Pick<ResolvedConfig, 'maxWorkspaceEntries' | 'maxWorkspaceBytes'>): Promise<WorkspaceSnapshot> {
  const entries = new Map<string, SnapshotEntry>()
  let fileBytes = 0
  await visit(workspace, '')
  const encoded = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([path, entry]) => ({
    path,
    ...entry,
  }))
  return Object.freeze({
    sha256: sha256(canonicalJson(encoded as JsonValue)),
    entries,
    fileBytes,
  })

  async function visit(directory: string, prefix: string): Promise<void> {
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right, 'en'))
    for (const name of names) {
      const absolute = join(directory, name)
      const path = prefix.length === 0 ? name : `${prefix}/${name}`
      const stat = await lstat(absolute)
      if (stat.isDirectory()) {
        add(path, { type: 'directory' })
        await visit(absolute, path)
      } else if (stat.isFile()) {
        fileBytes += stat.size
        if (fileBytes > config.maxWorkspaceBytes) {
          throw new Error(`dsh-eval workspace exceeds ${config.maxWorkspaceBytes} bytes`)
        }
        const bytes = await readFile(absolute)
        add(path, { type: 'file', sha256: sha256(bytes), bytes: bytes.byteLength })
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(absolute)
        add(path, { type: 'symlink', target, sha256: sha256(target) })
      } else {
        throw new Error(`dsh-eval workspace contains unsupported entry ${path}`)
      }
    }
  }

  function add(path: string, entry: SnapshotEntry): void {
    if (entries.size >= config.maxWorkspaceEntries) {
      throw new Error(`dsh-eval workspace exceeds ${config.maxWorkspaceEntries} entries`)
    }
    entries.set(path, Object.freeze(entry))
  }
}

export function diffWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): readonly WorkspaceChange[] {
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()])
  const changes: WorkspaceChange[] = []
  for (const path of [...paths].sort((left, right) => left.localeCompare(right, 'en'))) {
    const oldEntry = before.entries.get(path)
    const newEntry = after.entries.get(path)
    if (oldEntry === undefined && newEntry !== undefined) {
      changes.push(Object.freeze({ path, kind: 'added', ...(newEntry.sha256 === undefined ? {} : { afterSha256: newEntry.sha256 }) }))
      continue
    }
    if (oldEntry !== undefined && newEntry === undefined) {
      changes.push(Object.freeze({ path, kind: 'removed', ...(oldEntry.sha256 === undefined ? {} : { beforeSha256: oldEntry.sha256 }) }))
      continue
    }
    if (oldEntry !== undefined && newEntry !== undefined && !sameEntry(oldEntry, newEntry)) {
      changes.push(Object.freeze({
        path,
        kind: 'modified',
        ...(oldEntry.sha256 === undefined ? {} : { beforeSha256: oldEntry.sha256 }),
        ...(newEntry.sha256 === undefined ? {} : { afterSha256: newEntry.sha256 }),
      }))
    }
  }
  return Object.freeze(changes)
}

/** Resolve an assertion path and reject every intermediate symlink. */
export async function resolveWorkspaceEntry(workspace: string, relativePath: string, allowFinalSymlink = false): Promise<string> {
  const root = resolve(workspace)
  const target = resolve(root, relativePath)
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || relation.length === 0) {
    throw new Error('assertion path escapes or selects the workspace root')
  }
  const segments = relation.split(sep)
  let cursor = root
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index] as string)
    const stat = await lstat(cursor).catch(error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return undefined
      throw error
    })
    if (stat === undefined) return target
    const final = index === segments.length - 1
    if (stat.isSymbolicLink() && (!final || !allowFinalSymlink)) throw new Error(`assertion path crosses symbolic link ${segments.slice(0, index + 1).join('/')}`)
  }
  return target
}

export async function cloneWorkspaceForScorer(workspace: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(dirname(workspace), `scorer-${basename(workspace)}-`))
  const path = join(root, 'workspace')
  await cp(workspace, path, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  return Object.freeze({
    path,
    async dispose() { await removeOwnedRunPath(root, dirname(workspace)) },
  })
}

export async function removeRunWorkspace(run: RunWorkspace, runsPath: string): Promise<void> {
  await removeOwnedRunPath(run.root, runsPath)
}

async function removeOwnedRunPath(target: string, owner: string): Promise<void> {
  const resolvedOwner = resolve(owner)
  const resolvedTarget = resolve(target)
  const relation = relative(resolvedOwner, resolvedTarget)
  if (relation.length === 0 || relation === '..' || relation.startsWith(`..${sep}`) || !basename(resolvedTarget).startsWith('run-') && !basename(resolvedTarget).startsWith('scorer-')) {
    throw new Error('dsh-eval refused to remove a path it does not own')
  }
  await removeTreeWithoutFollowingLinks(resolvedTarget)
}

async function removeTreeWithoutFollowingLinks(target: string): Promise<void> {
  const stat = await lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (stat === undefined) return
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await rm(target, { force: true })
    return
  }
  for (const name of await readdir(target)) await removeTreeWithoutFollowingLinks(join(target, name))
  await rmdir(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

function sameEntry(left: SnapshotEntry, right: SnapshotEntry): boolean {
  return left.type === right.type && left.sha256 === right.sha256 && left.bytes === right.bytes && left.target === right.target
}
