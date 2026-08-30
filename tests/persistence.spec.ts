import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { persistReport } from '../src/persistence.ts'
import type { EvaluationReport } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('report publication', () => {
  it('restores an existing JSON report when its Markdown peer cannot be published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-eval-persistence-'))
    roots.push(root)
    const json = join(root, 'report.json')
    const markdown = join(root, 'report.md')
    await writeFile(json, 'previous-json\n', 'utf8')
    await mkdir(markdown)

    await expect(persistReport({} as EvaluationReport, 'new markdown\n', json)).rejects.toThrow('regular file')
    expect(await readFile(json, 'utf8')).toBe('previous-json\n')
  })
})
