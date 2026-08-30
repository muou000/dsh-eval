import { isAbsolute, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigSchema, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('derives explicit private data locations and conservative defaults', () => {
    const config = resolveConfig({ dshHome: resolve('test-home') }, {})
    expect(isAbsolute(config.reportsPath)).toBe(true)
    expect(isAbsolute(config.runsPath)).toBe(true)
    expect(config.reportsPath).not.toBe(config.runsPath)
    expect(config.defaultTimeoutMs).toBe(300_000)
    expect(config.maxConcurrency).toBe(1)
    expect(config.keepWorkspaces).toBe('never')
    expect(config.includeProcessOutput).toBe(false)
    expect(config.maxWorkspaceEntries).toBe(20_000)
    expect(config.maxWorkspaceBytes).toBe(268_435_456)
  })

  it('preserves Loader schema defaults', () => {
    const parsed = ConfigSchema({ dshHome: resolve('test-home') })
    expect(resolveConfig(parsed, {}).maxOutputBytes).toBe(1_000_000)
  })

  it('rejects relative paths, unknown keys, aliases, and wrong primitive types', () => {
    expect(() => resolveConfig({ dshHome: 'relative' }, {})).toThrow('absolute')
    expect(() => resolveConfig({ dshHome: resolve('home'), typo: true } as never, {})).toThrow('unknown key')
    expect(() => resolveConfig({ includeProcessOutput: 'yes' as never }, {})).toThrow('boolean')
    expect(() => resolveConfig({ maxConcurrency: 0 }, {})).toThrow('integer')
    const same = resolve('same')
    expect(() => resolveConfig({ reportsPath: same, runsPath: same }, {})).toThrow('different')
  })
})
