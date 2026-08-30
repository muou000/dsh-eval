# dsh-eval report: keyless-smoke-2026-08-30T08-04-54-452Z-9a126bef

Decision: **PASS**

Manifest: `keyless-smoke`
Dataset: `keyless-write-answer@1.0.0`

| Variant | Runs | Success | Mean score | Mean duration (ms) | p95 duration (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline (`known-bad`) | 5 | 0/5 (0.00%) | 0.4286 | 96.52 | 99.36 |
| candidate (`known-good`) | 5 | 5/5 (100.00%) | 1.0000 | 99.95 | 104.64 |

Paired delta: success +1.0000, score +0.5714; improved 5, regressed 0, tied 0.

Assurance: `local-trusted-process`. Policy PASS is not an automatic-promotion proof; hostile candidates require external isolation and independently observed telemetry.

## Release gates

| Gate | Result | Actual | Expected |
| --- | --- | ---: | ---: |
| minimumCandidateSuccessRate | PASS | 1 | 1 |
| minimumSuccessRateDelta | PASS | 1 | 1 |
| minimumMeanScoreDelta | PASS | 0.5714285714285714 | 0.5 |
| maximumPairRegressionCount | PASS | 0 | 0 |
| maximumTaskRegressionCount | PASS | 0 | 0 |
| maximumMeanDurationRegressionRatio | PASS | 0.03552298055204073 | 100 |
| maximumP95DurationRegressionRatio | PASS | 0.05312117872616695 | 100 |
| requireNoSafetyRegression | PASS | true | true |
| requireNoPrivacyRegression | PASS | true | true |
| requireNoStabilityRegression | PASS | true | true |

## Input identity

- Manifest SHA-256: `34b772808ab296b15547942c812bf6b9fc1e6db394f2d87118aedeb75bd2afd5`
- Dataset SHA-256: `5426db828562f167eb469c580766354900267c3a3d68d5bca0886a981ce05491`
- Scorer SHA-256: `9490bd9db836382ebfa5883aae3b13010a9160bded961785bc1714ec354e36c3`
- Evaluator artifact SHA-256: `2145b3f161c8a4ce8aaa6f92c3b6c67ebfe5b3745a398bbff3c6ee6d9c2511bf`
- Baseline variant SHA-256: `48d1bb88fbe75aeedbe1f228deb6d2dda31cbf1ab940e9d29821218053012dc7`
- Candidate variant SHA-256: `84de4859c1cbdbabac0b923594ae39ffc0648b4125070729acf2ccdf644c6d72`
