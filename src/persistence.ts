import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import type { EvaluationReport } from './types.ts'

export interface PersistedReportPaths {
  readonly json: string
  readonly markdown: string
}

/** Publish both projections with rollback so a write failure cannot leave a mismatched pair. */
export async function persistReport(report: EvaluationReport, markdown: string, outputPath: string): Promise<PersistedReportPaths> {
  const json = resolve(outputPath)
  if (extname(json).toLowerCase() !== '.json') throw new Error('dsh-eval report output must end in .json')
  const markdownPath = `${json.slice(0, -5)}.md`
  await mkdir(dirname(json), { recursive: true, mode: 0o700 })
  const transaction = randomUUID()
  const jsonTemporary = `${json}.${transaction}.tmp`
  const markdownTemporary = `${markdownPath}.${transaction}.tmp`
  const jsonBackup = `${json}.${transaction}.bak`
  const markdownBackup = `${markdownPath}.${transaction}.bak`
  let jsonBackedUp = false
  let markdownBackedUp = false
  let jsonPublished = false
  let markdownPublished = false
  try {
    await Promise.all([
      writeFile(jsonTemporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
      writeFile(markdownTemporary, markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    ])
    jsonBackedUp = await backupIfPresent(json, jsonBackup)
    markdownBackedUp = await backupIfPresent(markdownPath, markdownBackup)
    await rename(jsonTemporary, json)
    jsonPublished = true
    await rename(markdownTemporary, markdownPath)
    markdownPublished = true
    await Promise.all([rm(jsonBackup, { force: true }), rm(markdownBackup, { force: true })])
    jsonBackedUp = false
    markdownBackedUp = false
  } catch (error) {
    if (jsonPublished) await rm(json, { force: true })
    if (markdownPublished) await rm(markdownPath, { force: true })
    const restorationErrors: unknown[] = []
    if (jsonBackedUp) {
      await rename(jsonBackup, json).then(() => { jsonBackedUp = false }, restoreError => { restorationErrors.push(restoreError) })
    }
    if (markdownBackedUp) {
      await rename(markdownBackup, markdownPath).then(() => { markdownBackedUp = false }, restoreError => { restorationErrors.push(restoreError) })
    }
    if (restorationErrors.length > 0) throw new AggregateError([error, ...restorationErrors], 'dsh-eval report publication and rollback failed')
    throw error
  } finally {
    await Promise.all([
      rm(jsonTemporary, { force: true }),
      rm(markdownTemporary, { force: true }),
      ...(jsonBackedUp ? [] : [rm(jsonBackup, { force: true })]),
      ...(markdownBackedUp ? [] : [rm(markdownBackup, { force: true })]),
    ])
  }
  return Object.freeze({ json, markdown: markdownPath })
}

async function backupIfPresent(target: string, backup: string): Promise<boolean> {
  const stat = await lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (stat === undefined) return false
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('dsh-eval report target must be a regular file')
  try {
    await rename(target, backup)
    return true
  } catch (error) {
    throw error
  }
}
