import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { assertInside, canonicalJson, digestTree, InputIntegrityError, resolveInside, sha256 } from './integrity.ts'
import type { EvalAssertion, EvalVariant, JsonValue, LoadedEvalCase, LoadedEvalManifest } from './types.ts'
import { parseCase, parseManifest } from './validation.ts'

/** Load, validate, and content-address every evaluator-controlled input. */
export async function loadManifest(path: string): Promise<LoadedEvalManifest> {
  const sourcePath = resolve(path)
  const sourceDirectory = dirname(sourcePath)
  const manifest = parseManifest(await readJson(sourcePath, 'manifest'))
  const cases: LoadedEvalCase[] = []
  const datasetInputs: JsonValue[] = []
  const scorerInputs: JsonValue[] = []
  const variantArtifactSha256 = {
    baseline: {} as Record<string, string>,
    candidate: {} as Record<string, string>,
  }

  for (const role of ['baseline', 'candidate'] as const) {
    for (const artifact of manifest.variants[role].artifacts ?? []) {
      const path = resolveInside(sourceDirectory, artifact, `manifest ${role} artifact`)
      variantArtifactSha256[role][artifact] = (await digestTree(path, `manifest ${role} artifact ${artifact}`)).sha256
    }
    assertEntryArtifactBound(manifest.variants[role], sourceDirectory, role)
  }

  for (const relativeCasePath of manifest.dataset.caseFiles) {
    const casePath = resolveInside(sourceDirectory, relativeCasePath, 'manifest case path')
    const evalCase = parseCase(await readJson(casePath, `case ${relativeCasePath}`))
    const caseDirectory = dirname(casePath)
    const fixturePath = evalCase.fixture === undefined ? undefined : resolve(caseDirectory, evalCase.fixture)
    if (fixturePath !== undefined) assertInside(sourceDirectory, fixturePath, `case ${evalCase.id} fixture`)
    const fixtureDigest = fixturePath === undefined
      ? undefined
      : await digestTree(fixturePath, `case ${evalCase.id} fixture`)
    const scriptDigests: Array<{ assertionId: string; path: string; sha256: string }> = []
    for (const assertion of evalCase.assertions) {
      if (assertion.kind !== 'trusted-script') continue
      const scriptPath = resolve(caseDirectory, assertion.script)
      assertInside(sourceDirectory, scriptPath, `case ${evalCase.id} trusted script`)
      const digest = await digestTree(scriptPath, `case ${evalCase.id} trusted script`)
      if (digest.entries.length !== 1 || digest.entries[0]?.type !== 'file') {
        throw new Error(`case ${evalCase.id} trusted script must be a regular file`)
      }
      scriptDigests.push({ assertionId: assertion.id, path: assertion.script, sha256: digest.sha256 })
    }
    const loaded: LoadedEvalCase = Object.freeze({
      ...evalCase,
      sourcePath: casePath,
      sourceDirectory: caseDirectory,
      ...(fixtureDigest === undefined ? {} : { fixtureSha256: fixtureDigest.sha256 }),
      trustedScriptSha256: Object.freeze(Object.fromEntries(scriptDigests.map(entry => [entry.assertionId, entry.sha256]))),
    })
    cases.push(loaded)
    datasetInputs.push({
      case: evalCase as unknown as JsonValue,
      ...(fixtureDigest === undefined ? {} : { fixtureSha256: fixtureDigest.sha256 }),
    })
    scorerInputs.push({
      caseId: evalCase.id,
      expectedExitCode: evalCase.expectedExitCode ?? 0,
      assertions: evalCase.assertions as unknown as JsonValue,
      scripts: scriptDigests as unknown as JsonValue,
    })
  }

  const duplicateCase = cases.find((entry, index) => cases.findIndex(candidate => candidate.id === entry.id) !== index)
  if (duplicateCase !== undefined) throw new Error(`dataset contains duplicate case id "${duplicateCase.id}"`)
  if (manifest.thresholds !== undefined) {
    const releaseCases = cases.filter(evalCase => manifest.execution?.splits?.includes(evalCase.split) === true)
    for (const category of ['quality', 'safety', 'privacy', 'stability'] as const) {
      const covered = releaseCases.some(evalCase => evalCase.assertions.some(assertion =>
        (assertion.category ?? 'quality') === category && assertion.required !== false))
      if (!covered) throw new Error(`manifest release thresholds require a required ${category} assertion`)
    }
  }

  const manifestJson = manifest as unknown as JsonValue
  const variantHashes = {
    baseline: sha256(canonicalJson({
      variant: manifest.variants.baseline as unknown as JsonValue,
      artifacts: variantArtifactSha256.baseline,
    } as unknown as JsonValue)),
    candidate: sha256(canonicalJson({
      variant: manifest.variants.candidate as unknown as JsonValue,
      artifacts: variantArtifactSha256.candidate,
    } as unknown as JsonValue)),
  }
  return Object.freeze({
    ...manifest,
    sourcePath,
    sourceDirectory,
    cases: Object.freeze(cases),
    manifestHash: sha256(canonicalJson(manifestJson)),
    datasetHash: sha256(canonicalJson(datasetInputs)),
    scorerHash: sha256(canonicalJson(scorerInputs)),
    variantHashes: Object.freeze(variantHashes),
    variantArtifactSha256: Object.freeze({
      baseline: Object.freeze(variantArtifactSha256.baseline),
      candidate: Object.freeze(variantArtifactSha256.candidate),
    }),
  })
}

/** Re-read candidate-controlled artifacts around every observation to detect post-load mutation. */
export async function assertVariantArtifactsUnchanged(manifest: LoadedEvalManifest): Promise<void> {
  for (const role of ['baseline', 'candidate'] as const) {
    for (const [artifact, expected] of Object.entries(manifest.variantArtifactSha256[role])) {
      const path = resolveInside(manifest.sourceDirectory, artifact, `manifest ${role} artifact`)
      const actual = (await digestTree(path, `manifest ${role} artifact ${artifact}`)).sha256
      if (actual !== expected) throw new InputIntegrityError(`${role} artifact changed after manifest load`)
    }
  }
}

/** Re-read fixtures and executable scorers before report publication. */
export async function assertCaseInputsUnchanged(manifest: LoadedEvalManifest): Promise<void> {
  for (const evalCase of manifest.cases) {
    if (evalCase.fixture !== undefined) {
      const path = resolve(evalCase.sourceDirectory, evalCase.fixture)
      const actual = (await digestTree(path, `case ${evalCase.id} fixture`)).sha256
      if (actual !== evalCase.fixtureSha256) throw new InputIntegrityError(`case ${evalCase.id} fixture changed after manifest load`)
    }
    for (const assertion of evalCase.assertions) {
      if (assertion.kind !== 'trusted-script') continue
      const path = resolve(evalCase.sourceDirectory, assertion.script)
      const actual = (await digestTree(path, `case ${evalCase.id} trusted scorer ${assertion.id}`)).sha256
      if (actual !== evalCase.trustedScriptSha256[assertion.id]) {
        throw new InputIntegrityError(`case ${evalCase.id} trusted scorer ${assertion.id} changed after manifest load`)
      }
    }
  }
}

function assertEntryArtifactBound(variant: EvalVariant, manifestDirectory: string, role: 'baseline' | 'candidate'): void {
  if (variant.entryArtifact === undefined) return
  const expected = resolveInside(manifestDirectory, variant.entryArtifact, `manifest ${role} entry artifact`)
  const candidates = [variant.executable, ...(variant.args ?? [])]
    .map(value => value.replaceAll('{manifestDir}', manifestDirectory))
    .filter(value => !value.includes('{workspace}') && isAbsolute(value))
    .map(value => resolve(value))
  const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  if (!candidates.some(candidate => normalize(candidate) === normalize(expected))) {
    throw new Error(`manifest ${role}.entryArtifact must resolve to the executable or one literal argv entry`)
  }
}

async function readJson(path: string, label: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`dsh-eval cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`dsh-eval cannot parse ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Strip loaded source metadata before serializing or hashing a case. */
export function caseAssertions(evalCase: LoadedEvalCase): readonly EvalAssertion[] {
  return evalCase.assertions
}
