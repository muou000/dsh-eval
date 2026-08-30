import { describe, expect, it } from 'vitest'
import { parseCase, parseManifest } from '../src/validation.ts'

const manifest = {
  schema: 'dsh-eval-manifest',
  schemaVersion: 1,
  id: 'sample',
  dataset: { id: 'sample-cases', version: '1', caseFiles: ['cases/one.json'] },
  variants: {
    baseline: { id: 'base', revision: 'abc', executable: 'node', args: ['{manifestDir}/base.mjs'] },
    candidate: { id: 'next', revision: 'def', executable: 'node', args: ['{manifestDir}/next.mjs'] },
  },
}

const evalCase = {
  schema: 'dsh-eval-case',
  schemaVersion: 1,
  id: 'one',
  family: 'writing',
  split: 'validation',
  task: 'write the answer',
  fixture: '../fixture',
  assertions: [{ id: 'answer', kind: 'file-content', path: 'answer.txt', operator: 'equals', expected: '42' }],
}

describe('manifest validation', () => {
  it('accepts a complete versioned manifest and freezes structured fields', () => {
    const parsed = parseManifest(manifest)
    expect(parsed.variants.candidate.revision).toBe('def')
    expect(Object.isFrozen(parsed.dataset.caseFiles)).toBe(true)
  })

  it('rejects unknown fields and secrets embedded in a manifest', () => {
    expect(() => parseManifest({ ...manifest, surprise: true })).toThrow('unknown key')
    expect(() => parseManifest({
      ...manifest,
      variants: {
        ...manifest.variants,
        candidate: { ...manifest.variants.candidate, env: { OPENAI_API_KEY: 'secret' } },
      },
    })).toThrow('inheritEnv')
  })

  it('reserves isolation environment names case-insensitively', () => {
    expect(() => parseManifest({
      ...manifest,
      variants: { ...manifest.variants, candidate: { ...manifest.variants.candidate, env: { home: 'host' } } },
    })).toThrow('reserved')
    expect(() => parseManifest({
      ...manifest,
      variants: { ...manifest.variants, candidate: { ...manifest.variants.candidate, inheritEnv: ['Dsh_Eval_Workspace'] } },
    })).toThrow('reserved')
  })

  it('rejects path traversal and unknown placeholders', () => {
    expect(() => parseManifest({
      ...manifest,
      dataset: { ...manifest.dataset, caseFiles: ['../heldout.json'] },
    })).toThrow('escape')
    expect(() => parseManifest({
      ...manifest,
      variants: { ...manifest.variants, candidate: { ...manifest.variants.candidate, args: ['{task}'] } },
    })).toThrow('unknown placeholder')
  })

  it('rejects partial release policies and implicit model sampling', () => {
    const releaseVariant = (id: string, entry: string) => ({
      id,
      revision: id,
      executable: 'node',
      args: [`{manifestDir}/${entry}`],
      artifacts: [entry],
      entryArtifact: entry,
      runtime: { harnessVersion: 'test', profile: 'test' },
    })
    expect(() => parseManifest({
      ...manifest,
      variants: { baseline: releaseVariant('base', 'base.mjs'), candidate: releaseVariant('next', 'next.mjs') },
      execution: { splits: ['test'], repetitions: 5 },
      thresholds: { minimumCandidateSuccessRate: 1 },
    })).toThrow('minimumMeanScoreDelta')
    expect(() => parseManifest({
      ...manifest,
      variants: {
        ...manifest.variants,
        candidate: {
          ...manifest.variants.candidate,
          runtime: {
            harnessVersion: 'test',
            profile: 'test',
            provider: 'mock',
            model: 'mock',
            sampling: { temperature: 0 },
          },
        },
      },
    })).toThrow('topP')
  })
})

describe('case validation', () => {
  it('accepts an isolated fixture and explicit external assertion', () => {
    const parsed = parseCase(evalCase)
    expect(parsed.expectedExitCode).toBeUndefined()
    expect(parsed.assertions[0]?.kind).toBe('file-content')
  })

  it('rejects duplicate assertion ids and invalid JSON pointers', () => {
    expect(() => parseCase({ ...evalCase, assertions: [] })).toThrow('at least one')
    expect(() => parseCase({
      ...evalCase,
      assertions: [evalCase.assertions[0], evalCase.assertions[0]],
    })).toThrow('duplicates')
    expect(() => parseCase({
      ...evalCase,
      assertions: [{ id: 'json', kind: 'json-value', path: 'a.json', pointer: 'missing-slash', operator: 'exists' }],
    })).toThrow('JSON Pointer')
  })

  it('rejects absolute and escaping assertion paths', () => {
    expect(() => parseCase({
      ...evalCase,
      assertions: [{ ...evalCase.assertions[0], path: '../answer.txt' }],
    })).toThrow('escape')
  })
})
