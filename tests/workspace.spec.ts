import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { digestTree } from '../src/integrity.ts'
import { createRunWorkspace, diffWorkspace, removeRunWorkspace, resolveWorkspaceEntry, snapshotWorkspace } from '../src/workspace.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('workspace evidence boundary', () => {
  it('hashes deterministic world state and reports added/modified/removed paths', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-workspace-'))
    await writeFile(join(root, 'old.txt'), 'old', 'utf8')
    await writeFile(join(root, 'remove.txt'), 'remove', 'utf8')
    const limits = { maxWorkspaceEntries: 100, maxWorkspaceBytes: 1_000 }
    const before = await snapshotWorkspace(root, limits)
    await writeFile(join(root, 'old.txt'), 'new', 'utf8')
    await rm(join(root, 'remove.txt'))
    await writeFile(join(root, 'add.txt'), 'add', 'utf8')
    const after = await snapshotWorkspace(root, limits)
    expect(before.sha256).not.toBe(after.sha256)
    expect(diffWorkspace(before, after).map(change => [change.path, change.kind])).toEqual([
      ['add.txt', 'added'],
      ['old.txt', 'modified'],
      ['remove.txt', 'removed'],
    ])
  })

  it('rejects source fixture links and assertion traversal through candidate links', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-workspace-'))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(workspace), mkdir(outside)])
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
    const link = join(workspace, 'escape')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(digestTree(workspace, 'fixture')).rejects.toThrow('symbolic link')
    await expect(resolveWorkspaceEntry(workspace, 'escape/secret.txt')).rejects.toThrow('symbolic link')
  })

  it('removes owned runs without following a candidate-created directory link', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-workspace-'))
    const outside = join(root, 'outside')
    const runsPath = join(root, 'runs')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel.txt'), 'keep', 'utf8')
    const config = resolveConfig({
      dshHome: join(root, 'home'),
      reportsPath: join(root, 'reports'),
      runsPath,
    }, {})
    const run = await createRunWorkspace(config, undefined, undefined)
    await symlink(outside, join(run.workspace, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await removeRunWorkspace(run, runsPath)
    expect(await import('node:fs/promises').then(fs => fs.readFile(join(outside, 'sentinel.txt'), 'utf8'))).toBe('keep')
  })
})
