import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { load as loadYaml } from 'js-yaml'
import * as evaluation from '../src/index.ts'
import { writeTestSuite } from './helpers.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('runs a paired suite through ctx.evals, hot-unloads cleanly, and reloads', { timeout: 30_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-loader-'))
    const manifest = await writeTestSuite(root)
    const configPath = join(root, 'cordis.yml')
    const portable = root.replaceAll('\\', '/')
    const patch = loadYaml(await readFile(resolve('cordis.patch.yml'), 'utf8')) as Array<{
      insert?: Array<{ id?: string; name?: string; config?: Record<string, unknown> }>
    }>
    const row = patch.flatMap(operation => operation.insert ?? []).find(entry => entry.id === 'dsh-eval')
    expect(row).toMatchObject({ id: 'dsh-eval', name: '@muou000/dsh-eval' })
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      `- name: '${row?.name}'`,
      '  config:',
      `    dshHome: '${portable}'`,
      `    reportsPath: '${portable}/reports'`,
      `    runsPath: '${portable}/runs'`,
      '',
    ].join('\n'), 'utf8')
    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@muou000/dsh-eval', evaluation],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    const unloaded = [...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded).toEqual([])

    expect((await context.evals.run(manifest)).decision).toBe('pass')
    const previous = context.evals
    const entry = [...context.loader.entries()].find(item => item.options.name === '@muou000/dsh-eval')
    expect(entry).toBeDefined()
    await context.loader.update(entry!.id, { disabled: true })
    await context.loader.await()
    expect(context.get('evals')).toBeUndefined()
    await expect(previous.run(manifest)).rejects.toThrow('disposed')

    await context.loader.update(entry!.id, { disabled: false })
    await context.loader.await()
    expect(context.evals).not.toBe(previous)
    expect((await context.evals.run(manifest)).decision).toBe('pass')
  })
})
