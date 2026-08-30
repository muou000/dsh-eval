#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { resolveConfig } from './config.ts'
import { Evaluator } from './evaluator.ts'
import { loadManifest } from './manifest.ts'
import type { EvalSplit } from './types.ts'
import { EVALUATOR_VERSION } from './version.ts'

interface CliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export interface CliSignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void
}

const defaultIo: CliIo = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

const defaultSignals: CliSignalSource = {
  on: (signal, listener) => { process.on(signal, listener) },
  off: (signal, listener) => { process.off(signal, listener) },
}

/** Run the standalone evaluator CLI without terminating the hosting process. */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo, signals: CliSignalSource = defaultSignals): Promise<number> {
  try {
    const command = argv[0]
    if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
      io.stdout(helpText())
      return 0
    }
    if (command === '--version' || command === '-v') {
      io.stdout(`${EVALUATOR_VERSION}\n`)
      return 0
    }
    if (command !== 'run' && command !== 'validate') throw new Error(`unknown command "${command}"`)
    const parsed = parseOptions(argv.slice(1))
    if (parsed.manifest === undefined) throw new Error(`${command} requires a manifest path`)
    if (command === 'validate') {
      rejectRunOnlyOptions(parsed)
      const manifest = await loadManifest(parsed.manifest)
      io.stdout(`${JSON.stringify({
        valid: true,
        manifestId: manifest.id,
        manifestHash: manifest.manifestHash,
        datasetId: manifest.dataset.id,
        datasetVersion: manifest.dataset.version,
        datasetHash: manifest.datasetHash,
        scorerHash: manifest.scorerHash,
        cases: manifest.cases.length,
        splits: Object.fromEntries(['development', 'validation', 'test'].map(split => [split, manifest.cases.filter(evalCase => evalCase.split === split).length])),
      }, null, 2)}\n`)
      return 0
    }

    const config = resolveConfig({
      ...(parsed.reportsPath === undefined ? {} : { reportsPath: parsed.reportsPath }),
      ...(parsed.runsPath === undefined ? {} : { runsPath: parsed.runsPath }),
      ...(parsed.maxConcurrency === undefined ? {} : { maxConcurrency: parsed.maxConcurrency }),
      includeProcessOutput: parsed.includeOutput,
    })
    const evaluator = new Evaluator(config)
    const controller = new AbortController()
    let receivedSignal: 'SIGINT' | 'SIGTERM' | undefined
    const onSigint = (): void => abortForSignal('SIGINT')
    const onSigterm = (): void => abortForSignal('SIGTERM')
    signals.on('SIGINT', onSigint)
    signals.on('SIGTERM', onSigterm)
    try {
      let report
      try {
        report = await evaluator.run(parsed.manifest, {
          ...(parsed.output === undefined ? {} : { outputPath: parsed.output }),
          ...(parsed.splits.length === 0 ? {} : { splits: parsed.splits }),
          includeProcessOutput: parsed.includeOutput,
          signal: controller.signal,
        })
      } catch (error) {
        if (receivedSignal !== undefined) {
          io.stderr(`dsh-eval: interrupted by ${receivedSignal}\n`)
          return receivedSignal === 'SIGINT' ? 130 : 143
        }
        throw error
      }
      io.stdout(`${JSON.stringify({
        runId: report.runId,
        decision: report.decision,
        baselineSuccessRate: report.baseline.successRate,
        candidateSuccessRate: report.candidate.successRate,
        successRateDelta: report.paired.successRateDelta,
        regressions: report.paired.candidateRegressed,
        manifestHash: report.manifestHash,
        datasetHash: report.datasetHash,
        scorerHash: report.scorerHash,
        evaluatorArtifactSha256: report.evaluatorArtifactSha256,
      }, null, 2)}\n`)
      return parsed.requirePass && report.decision !== 'pass' ? 2 : 0
    } finally {
      await evaluator.dispose()
      signals.off('SIGINT', onSigint)
      signals.off('SIGTERM', onSigterm)
    }

    function abortForSignal(signal: 'SIGINT' | 'SIGTERM'): void {
      receivedSignal ??= signal
      if (!controller.signal.aborted) controller.abort(new Error(`dsh-eval received ${signal}`))
    }
  } catch (error) {
    io.stderr(`dsh-eval: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

interface ParsedOptions {
  manifest: string | undefined
  output: string | undefined
  reportsPath: string | undefined
  runsPath: string | undefined
  maxConcurrency: number | undefined
  splits: EvalSplit[]
  includeOutput: boolean
  requirePass: boolean
}

function parseOptions(argv: readonly string[]): ParsedOptions {
  let manifest: string | undefined
  let output: string | undefined
  let reportsPath: string | undefined
  let runsPath: string | undefined
  let maxConcurrency: number | undefined
  const splits: EvalSplit[] = []
  let includeOutput = false
  let requirePass = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] as string
    if (!value.startsWith('-')) {
      if (manifest !== undefined) throw new Error('only one manifest path is allowed')
      manifest = resolve(value)
      continue
    }
    if (value === '--include-output') { includeOutput = true; continue }
    if (value === '--require-pass') { requirePass = true; continue }
    const next = argv[index + 1]
    if (next === undefined) throw new Error(`${value} requires a value`)
    index += 1
    if (value === '--output') output = resolve(next)
    else if (value === '--reports-path') reportsPath = resolve(next)
    else if (value === '--runs-path') runsPath = resolve(next)
    else if (value === '--concurrency') maxConcurrency = parsePositiveInteger(next, value)
    else if (value === '--split') {
      if (!['development', 'validation', 'test'].includes(next)) throw new Error(`invalid split "${next}"`)
      if (splits.includes(next as EvalSplit)) throw new Error(`duplicate split "${next}"`)
      splits.push(next as EvalSplit)
    } else throw new Error(`unknown option "${value}"`)
  }
  return { manifest, output, reportsPath, runsPath, maxConcurrency, splits, includeOutput, requirePass }
}

function rejectRunOnlyOptions(options: ParsedOptions): void {
  if (options.output !== undefined || options.reportsPath !== undefined || options.runsPath !== undefined
    || options.maxConcurrency !== undefined || options.splits.length > 0 || options.includeOutput || options.requirePass) {
    throw new Error('validate accepts only a manifest path')
  }
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) throw new Error(`${option} must be an integer in [1, 16]`)
  return parsed
}

function helpText(): string {
  return [
    'Usage:',
    '  dsh-eval validate <manifest.json>',
    '  dsh-eval run <manifest.json> [--output report.json] [--split test]',
    '',
    'Run options:',
    '  --reports-path <absolute-or-relative-directory>',
    '  --runs-path <absolute-or-relative-directory>',
    '  --concurrency <1-16>',
    '  --include-output',
    '  --require-pass',
    '',
  ].join('\n')
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
