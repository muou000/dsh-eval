# AGENTS.md

`dsh-eval` owns deterministic paired evaluation, evaluator-controlled scoring,
and evidence reports. It does not own candidate generation, promotion state, or
deployment.

## Non-negotiable boundaries

- Treat manifest, case, fixture, scorer, and variant bytes as immutable inputs.
  An integrity mismatch aborts the suite and must never become a candidate score.
- The local process runner is for trusted code only. Do not set
  `promotionEligible` until an external runner provides hostile-code isolation,
  independently observed telemetry, and descendant-process containment.
- Keep baseline and candidate worlds separate. A pair shares only frozen task
  material and runs serially; different pairs may use bounded concurrency.
- Built-in or executable external-world verifiers are authoritative. Model
  judges may only be optional secondary signals.
- New thresholds require explicit missing-data behavior and regression tests.
  Missing or candidate-writable evidence fails closed.
- Never persist secrets, prompt bodies, tool arguments/output, or unredacted
  process output by default.

## Required checks

Run `pnpm run check` for every change. Lifecycle, process, Loader, persistence,
or packaging changes also require `pnpm run test:integration` and, from a clean
commit, `pnpm run eval:pack`. Re-run `pnpm run eval:keyless` whenever report,
manifest, scorer, planner, or threshold behavior changes. Record real-model,
Unix, external-sandbox, and built-DSH checks as not run unless they actually ran.
