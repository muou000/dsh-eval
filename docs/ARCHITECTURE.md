# dsh-eval architecture

## Problem and baseline

Self-evolution is unsafe when the same candidate can choose its task, modify its scorer, and announce that it improved. `dsh-eval` therefore treats evaluation as a release system with separate, content-addressed inputs and externally observed outcomes.

The keyless example is a calibration baseline: a frozen bad runner writes `41`, a frozen good runner writes `42`, and an evaluator-owned case requires `42`. The expected effect is known before implementation. Passing that suite proves signal direction, isolation, pairing, and report persistence; it says nothing about model quality.

## Trust flow

```text
versioned manifest + cases + fixtures + scorers + variant artifacts
                              |
                              v  validate + SHA-256 pin
                    deterministic run planner
                              |
                +-------------+-------------+
                |                           |
        baseline private world      candidate private world
                |                           |
        private artifact snapshot   private artifact snapshot
                |                           |
        shell-free child process    shell-free child process
                |                           |
        workspace snapshot/diff     workspace snapshot/diff
                +-------------+-------------+
                              |
             built-in assertions + trusted script clone
                              |
                   paired statistics + gates
                              |
              rollback-safe JSON + Markdown pair
```

Manifest/case/scorer inputs are never copied into the candidate workspace except for the declared fixture. `{manifestDir}` points to a per-observation snapshot containing only that variant's declared artifacts, not the source manifest, cases, labels or scorers. Trusted scripts are copied after candidate settlement and execute against a workspace clone. Built-in assertions resolve every path beneath the workspace and reject traversal through symbolic links.

## Determinism and pairing

The manifest fixes case order, repetitions, selected splits, seed, timeouts, output limit, concurrency, runtime identity and release thresholds. For each case the seeded planner chooses the first order, then alternates AB/BA; both observations in one pair run serially. Different pairs may run concurrently. Both observations share task and frozen fixture bytes but never share a mutable directory or DSH home.

Reports retain every observation and then derive:

- success rate plus Wilson 95% interval;
- score and duration mean/p50/p95/min/max;
- candidate improved/regressed/tied pair counts;
- success and mean-score paired deltas;
- optional token/cost distributions when every observation has probe evidence;
- required assertion failures by safety, privacy and stability category.

No threshold means `not-configured`. A configured metric with missing data fails its gate; it is never silently dropped.

## Process and lifecycle

Children launch with `shell: false`. The evaluator records `timedOut`, `aborted`, `exitCode`, `signal` and `spawnError` independently. stdout and stderr are streamed into complete byte counters and SHA-256 digests; only the first configured bytes are retained, and text is omitted from reports by default.

POSIX children run in their own process group. Windows timeout/cancel uses the exact owned PID with `taskkill /T /F`. `Evaluator.dispose()` and CLI SIGINT/SIGTERM abort active suites, stop workers from taking new pairs, wait for settlement and remove owned workspaces. A Windows process that exits normally after detaching a descendant is not reliably contained by Node `spawn`; external Job Object or container supervision is required for such runners.

## DSH integration

The package provides `ctx.evals` as the public capability and uses only public Cordis and DSH session events. Loading the same plugin inside an evaluator-spawned DSH process activates probe output when `DSH_EVAL_PROBE_TOKEN_FILE` is present.

The probe stores no prompts, messages, tool arguments, tool output or session ids. It counts sessions, turns/outcomes, model-call steps, tool calls/errors and durable usage buckets, then publishes a versioned document. The evaluated process receives both the path and identity fields, so validation detects malformed/replayed documents but cannot make the channel tamper-proof. Reports label it `trust: self-reported`; local token/cost release gates fail closed even when values exist.

## Input integrity

- `manifestHash`: normalized manifest fields, including runtime identity and artifact paths.
- `datasetHash`: normalized cases plus fixture tree digests.
- `scorerHash`: assertions, expected exits and trusted-script digests.
- `variantHash`: normalized variant config plus actual artifact tree digests.
- `evaluatorArtifactSha256`: module file actually loaded for the run (the shared evaluator chunk in a packaged CLI run).

Fixtures, trusted scripts and source artifacts are re-read around execution. Fixtures and artifacts are copied into evaluator-owned run roots and the copies are rehashed before use; the artifact snapshot is checked again after the process exits. Trusted scripts are copied and rehashed before execution. A mismatch raises `InputIntegrityError`, aborts the suite and publishes no decision report.

For a release run, artifact lists should contain packed plugin artifacts, ordered Cordis patches, runner code and the dependency lock. A Git revision string alone is descriptive metadata, not proof of bytes.

## Threat model

The core protects against accidental cross-run state, manifest path traversal, fixture/scorer/artifact mutation, output-memory exhaustion, symlink/junction traversal during scoring and cleanup, leaked default process output and missing release metrics. It does not claim hostile-code containment. A candidate with arbitrary native execution has the evaluator user's filesystem authority; every local report therefore has `promotionEligible: false`. Use a container/VM runner plus independently observed telemetry for adversarial candidates and automatic promotion.

LLM graders are intentionally absent from the authoritative core. A future scorer provider may add one as a secondary signal, but executable world-state verification and frozen human labels remain authoritative.
