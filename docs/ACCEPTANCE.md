# dsh-eval acceptance ledger

This ledger distinguishes implementation evidence from model/product evidence. `PASS` refers only to the exact stated gate; absent evidence is `NOT RUN`.

| Gate | Status | Evidence |
| --- | --- | --- |
| Strict manifest/case/config validation | PASS | Vitest config, validation and manifest suites |
| Fixture/scorer/artifact content identity | PASS | Hash stability, private execution snapshots, changed scorer/fixture and candidate snapshot-mutation tests |
| Shell-free process, output cap, timeout, cancel, spawn error | PASS | Real subprocess tests on Windows |
| Built-in external-world scorers | PASS | Paired evaluator case uses file, JSON, absence and trusted script checks |
| Pairing, fixed seed, alternating order, pair-serial repeated observations | PASS | Five-pair keyless evaluator test and persisted report |
| Missing or self-reported threshold data fails closed | PASS | Token/cost unit gates reject absent and candidate-writable probe data |
| DSH session probe contains no content | PASS | Real Cordis Session events; counts turn/model/tool/usage only |
| Cordis patch row, service load, hot unload, reload | PASS | Source-level Loader test reads the shipped `cordis.patch.yml` row and composes `ctx.evals`; current-DSH smoke composes and disposes the service through DSH's public built Cordis APIs |
| Disposal quiesces active child and removes workspace | PASS | Hanging-process lifecycle test |
| Windows normal-exit detached descendant containment | NOT IMPLEMENTED | Node `spawn` cannot provide kill-on-close Job ownership; local reports record this promotion blocker |
| Deterministic keyless calibration | PASS | `evals/reports/keyless-latest.json` after execution |
| Clean tarball install/public import/bin/patch/example/audit | PASS | `pack-smoke-latest.json`: tarball SHA-256 `ad1bbe5a...6d0`, source `3e1820f`, `sourceDirty=false` |
| Current DSH session-event compatibility | PASS | `current-dsh-smoke-latest.json`: plugin `3e1820f`, DSH `cd5ef814`, `@deepseek-ai/dsh-session` `0.1.2-alpha.1`; service, turn/model/tool/usage observation, content-free probe and disposal checks all pass |
| Source DSH CLI real-process composition | PASS | `dsh-real-process-latest.json`: packed plugin installed into a named `headless` profile; one keyless turn returned `DSH_EVAL_SOURCE_OK` |
| Built DSH SDK real-process composition | PASS | Same evidence ledger: public `DeepSeekHarness.run()` completed one keyless turn and returned `DSH_EVAL_BUILT_SDK_OK`; the prior inactive-context error did not reproduce |
| Real-model paired suite | NOT RUN | No credentials/models invoked in this implementation pass |
| Provider billing reconciliation | NOT RUN | Probe usage alone is insufficient for production cost claims |
| Unix runtime matrix | NOT RUN | Current implementation pass ran on Windows only |
| Container/VM hostile-candidate isolation | NOT RUN | Local core explicitly does not claim a security sandbox |
| Shadow/canary promotion and rollback drill | NOT RUN | Belongs to later controlled evolution rollout |

The committed keyless suite observed baseline `0/5` versus candidate `5/5`, success delta `+1.0`, mean-score delta `+0.5714`, and zero regressed pairs. Its local policy decision is `PASS`, while `promotionEligible` is explicitly `false`; the loaded evaluator artifact is bound by SHA-256 in the report. This is a calibration check, not a statistically meaningful claim about DSH, memory, compaction or skill evolution.

The current-DSH smoke binds plugin revision `3e1820f...` to clean DSH revision `cd5ef814...` and the current public Session event contract. The older real-process ledger binds the same DSH revision, plugin tarball SHA-256 `cf1919f...de74`, runtime versions, profile bundles, responses and probes. Both use candidate-writable self-reports, and the real-process run used a local mock OpenAI-compatible upstream. These passes establish installation and composition compatibility only; they do not replace a real-model paired evaluation or independent billing evidence.
