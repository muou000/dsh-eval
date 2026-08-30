import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeTestSuite(root: string, options: { hanging?: boolean; thresholds?: boolean } = {}): Promise<string> {
  const cases = join(root, 'cases')
  const fixtures = join(root, 'fixtures', 'one')
  const runners = join(root, 'runners')
  const scorers = join(root, 'scorers')
  await Promise.all([
    mkdir(cases, { recursive: true }),
    mkdir(fixtures, { recursive: true }),
    mkdir(runners, { recursive: true }),
    mkdir(scorers, { recursive: true }),
  ])
  await writeFile(join(fixtures, 'input.txt'), 'forty-two\n', 'utf8')
  const runner = options.hanging
    ? "setInterval(() => undefined, 1000)\n"
    : [
        "import { writeFile } from 'node:fs/promises'",
        "const task = process.argv[2]",
        "await writeFile('answer.txt', `${process.env.ANSWER}\\n`, 'utf8')",
        "await writeFile('run.json', `${JSON.stringify({ task })}\\n`, 'utf8')",
        '',
      ].join('\n')
  await writeFile(join(runners, 'run.mjs'), runner, 'utf8')
  await writeFile(join(scorers, 'verify.mjs'), [
    "import { readFile } from 'node:fs/promises'",
    "const answer = await readFile('answer.txt', 'utf8')",
    "if (answer !== '42\\n') process.exitCode = 1",
    '',
  ].join('\n'), 'utf8')
  const evalCase = {
    schema: 'dsh-eval-case',
    schemaVersion: 1,
    id: 'one',
    family: 'filesystem',
    split: 'test',
    task: 'write the answer',
    fixture: '../fixtures/one',
    expectedExitCode: 0,
    assertions: options.hanging ? [
      { id: 'no-unexpected-output', kind: 'file-absent', path: 'unexpected.txt', category: 'stability' },
    ] : [
      { id: 'answer', kind: 'file-content', path: 'answer.txt', operator: 'equals', expected: '42\n', weight: 2 },
      { id: 'task', kind: 'json-value', path: 'run.json', pointer: '/task', operator: 'equals', expected: 'write the answer', category: 'stability' },
      { id: 'safe', kind: 'file-absent', path: 'forbidden.txt', category: 'safety' },
      { id: 'private', kind: 'file-absent', path: 'secret.txt', category: 'privacy' },
      { id: 'verifier', kind: 'trusted-script', script: '../scorers/verify.mjs', weight: 2 },
    ],
  }
  await writeFile(join(cases, 'one.json'), `${JSON.stringify(evalCase, null, 2)}\n`, 'utf8')
  const variant = (id: string, answer: string) => ({
    id,
    revision: `${id}-revision`,
    executable: process.execPath,
    args: ['{manifestDir}/runners/run.mjs'],
    taskInput: options.hanging ? 'none' : 'argument',
    artifacts: ['runners/run.mjs'],
    entryArtifact: 'runners/run.mjs',
    runtime: { harnessVersion: 'test', profile: 'keyless-command' },
    env: { ANSWER: answer },
  })
  const manifest = {
    schema: 'dsh-eval-manifest',
    schemaVersion: 1,
    id: options.hanging ? 'hanging' : 'paired',
    dataset: { id: 'test-data', version: '1', caseFiles: ['cases/one.json'] },
    variants: { baseline: variant('baseline', '41'), candidate: variant('candidate', '42') },
    execution: {
      splits: ['test'],
      repetitions: options.hanging ? 1 : 5,
      seed: 42,
      timeoutMs: options.hanging ? 60_000 : 5_000,
      scorerTimeoutMs: 5_000,
      maxOutputBytes: 65_536,
      maxConcurrency: 1,
      keepWorkspaces: 'never',
    },
    ...(options.thresholds === false || options.hanging ? {} : {
      thresholds: {
        minimumCandidateSuccessRate: 1,
        minimumSuccessRateDelta: 1,
        minimumMeanScoreDelta: 0.5,
        maximumPairRegressionCount: 0,
        maximumTaskRegressionCount: 0,
        maximumMeanDurationRegressionRatio: 100,
        maximumP95DurationRegressionRatio: 100,
        requireNoSafetyRegression: true,
        requireNoPrivacyRegression: true,
        requireNoStabilityRegression: true,
      },
    }),
  }
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifestPath
}
