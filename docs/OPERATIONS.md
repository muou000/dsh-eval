# dsh-eval operations

## Storage

Defaults derive from `DSH_HOME`:

- reports: `<DSH_HOME>/eval/v1/reports`
- transient runs: `<DSH_HOME>/eval/v1/runs`

Report JSON is canonical evidence; Markdown is a generated projection. Default `keepWorkspaces=never` removes every run workspace. `failed` and `always` are explicit debugging modes and may retain private task data, so use them only in a protected directory with a deletion policy.

## Configuration

All paths must be absolute after CLI resolution. Operator limits include process/scorer timeout defaults, maximum output bytes, maximum concurrency, workspace entry/byte ceilings and assertion read size. A manifest cannot exceed the operator's concurrency or output cap.

Literal variant environment rejects secret-like names. Use `inheritEnv` to delegate only the credentials required by a real-model case. Evaluator-owned home/temp/probe and Node injection names cannot be inherited or overridden. Reports store delegated names only through the manifest, never their values.

## Runbook

1. Freeze development, validation and held-out cases before generating the candidate.
2. Pack baseline and candidate; record their Git commits and list the tarballs, patches, runner and lockfiles as artifacts.
3. Pin DSH/profile/provider/model/sampling and pricing in each variant.
4. Validate the manifest and review all thresholds before the run.
5. Run keyless/replay regression first, then the real-model channel with equal budgets.
6. Inspect every paired regression and every safety/privacy/stability failure, not only aggregate means.
7. Preserve JSON, Markdown, artifact hashes and human approval together. Do not promote on `not-configured`, and do not treat local `decision: pass` as `promotionEligible`.
8. Canary the approved artifact with an impact cap and rollback point outside this plugin.

## Failure response

- `input integrity failure`: stop; an artifact, fixture or scorer changed after registration. Re-freeze and create a new manifest version.
- timeout/abort: inspect independent process facts and retained workspace only if retention was explicitly enabled. Do not reclassify as a normal wrong answer.
- token/cost gate failure: local probe data is self-reported even when present. Re-run in external isolation with independently observed session/billing evidence; do not override the gate.
- workspace limit: treat as stability failure or raise the operator ceiling only after reviewing the case's expected output size.
- report write failure: no promotion evidence exists. The writer stages both projections and restores prior files on a publication failure; a machine crash still requires checking for retained `.bak` files.
- normal-exit descendant blocker on Windows: use a Job Object aware supervisor, container or VM. Do not rely on workspace deletion while a detached process may still run.

## Backup, rollback, and uninstall

Reports are append-only by convention; back up the report directory plus the exact artifacts it references. There is no mutable database or schema migration in v1.

To roll back the evaluator, pin the previous plugin package and retain old reports with their evaluator version. Never rewrite a report to make a newer evaluator appear equivalent.

Uninstall the plugin from the DSH profile, then remove `<DSH_HOME>/eval/v1/runs` only after confirming no evaluator process is active. Report deletion is a separate retention decision. No candidate package or target workspace is modified by uninstall.
