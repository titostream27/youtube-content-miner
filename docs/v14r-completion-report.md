# V14R Completion Report — Evidence Integrity, Cross-Platform Reproducibility & Truthful Closure

**Final verdict: BLOCKED — evidence closure complete; production activation NOT authorized**
(unchanged from V14; the correction work made the negative result reproducible and trustworthy)

## Baseline / final SHA
- Baseline: `557aaa7037a246b3636662d93bc5460d5826f369` (main after PR #9)
- Branch: `fix/brief-v14r-evidence-reproducibility-closure`
- Final SHA: merged as `9ee00248b1e` (merge commit of PR #10; CI head `247a86e8`)

## Original defects (F-01..F-08)
| ID | Priority | Status | Evidence |
|---|---|---|---|
| F-01 | P0 | CLOSED — E3 leakage claim corrected to 2 (c=9e121d6b7221, c=fb53d482602c) | `report_claims.json`, `policy_reconciliation.json` |
| F-02 | P0 | CLOSED — 7/90 old failures explained; new manifest 100% | `checksum_reconciliation.json` |
| F-03 | P0 | CLOSED — canonical case-sensitive paths | `artifact-paths.ts`, tests V14R-PATH-001/002 |
| F-04 | P0 | CLOSED — fail-closed loaders, census 424 asserted | tests V14R-PATH-003/004 |
| F-05 | P1 | CLOSED — blocking CI gate | `.github/workflows/ci.yml` |
| F-06 | P1 | CLOSED — deterministic FAIL audit executed | `fail_audit_*`, `consensus_labels_v14r.jsonl` |
| F-07 | P1 | CLOSED — SAF-001 recomputes and can fail | `v14-verify.ts`, `v14r-verify.ts` |
| F-08 | P1 | CLOSED — non-circular manifest, mutable excluded | `v14r-build-checksums.ts`, `SHA256SUMS` |

## Label audit (frozen protocol addendum `protocol-v14r.yaml`)
- Population: 150 V14 silver-FAIL; deterministic sample = byte-sorted ids at
  positions 20,40,60,80,100,120,140 → **7 candidates**:
  `c=293b9b02dca0`, `c=417a9ce3c85c`, `c=6745883eb40b`, `c=8824a0c3a18f`,
    `c=ab244e1f7fb9`, `c=db382577df0a`, `c=f389b51fbb63`
- Judge: independent Judge C (`cx/gpt-5.6-luna`), blinded PRE/CAND/POST windows
  only; **7/7 outputs ok** (0 provider/parse gaps); raw rows with input hashes in
  `fail_audit_judge_outputs.jsonl`.
- Outcome: **3 retained FAIL** (`c=6745883eb40b`, `c=ab244e1f7fb9`,
  `c=db382577df0a` — audit agrees with A/B); **4 → REVIEW**
    (`c=293b9b02dca0`, `c=417a9ce3c85c`, `c=8824a0c3a18f`, `c=f389b51fbb63` —
  audit judged them publishable, contradicting A/B consensus). Nothing was
  forced to PASS; erratum rows in `label_errata_v14r.jsonl`.
- Label counts on the 160-candidate set: before `{FAIL:150, REVIEW:2}` →
  after `{FAIL:146, REVIEW:6}` (PASS unchanged 8); `metrics_v14r.json`.

## Variant safety (exact accepted sets)
- V14R recomputation agrees with `policy_lock.json` for all variants:
  C0 SAFE; **E3 REJECT(2 new FAIL, 2 HN, 2 LK)** — new FAIL IDs:
  `c=9e121d6b7221`, `c=fb53d482602c` (both hard-negative AND
  next-topic-leakage flagged); E1/E2/E4 REJECT(3,3,3) (additionally
  `c=6065a196f512`); S1/S2 REJECT(2,2,2); NEGATIVE_CONTROL REJECT
  (410,353,332). `locked_variant: null`, `policy_reconciliation.json`
  matches_policy_lock: true.

## Checksums
- `evidence/v14r/SHA256SUMS`: **76 entries**, immutable, non-circular,
  LF-normalized text; **100% pass** on Windows (Node validator
  `scripts/v14r-check-checksums.ts`) and Ubuntu (`sha256sum -c` after git
  checkout).
- Manifest SHA-256: `92f555c0753bb2ff52c9516ec2cc38eb79e82f218a5e364a243447cc8c01f99f`
- Excluded (R-03): itself, `run_summary.json` (written_at),
  `verification_report.json` (self-referential), `ci_run_metadata.json`
  (updated post-CI), `census_new.jsonl` (acquired_at).

## Cross-platform
- **Linux/Ubuntu (CI)**: clean checkout → `npm ci`, `npx tsc --noEmit`,
  `npx vitest run`, `npx eslint . --max-warnings 0`, `npm run verify:v14r`,
  `node scripts/v14r-check-checksums.ts`, `git diff --check` — gate
  `v14r-evidence-gate` (see CI proof).
- **Windows (local)**: Node v22.23.1 + tsx; vitest **48 files / 343 tests**;
  tsc 0 errors; eslint 0 problems; `v14r-verify` **12/12 ok**; checksums
  **76/76 ok**; `git diff --check` clean (see `test_report.json`).

## Regression
- Vitest: **48 files, 343 tests** (333 pre-existing + 10 V14R path tests).
- tsc 0, eslint 0; verifier totals 12 PASS / 0 FAIL / 0 NOT-EVALUABLE.

## Production invariance
- `evidence/v14r/production_diff.txt`: only additive changes; protected paths
  (`src/lib/config.ts`, `topic-boundary.ts`, `boundary-repair.ts`,
  start-gates/`start-boundary`, scoring, ai, db, dispatch) **no diff**.
- Static check `V14R-PRD-001`: floor 0.82 / threshold 70 unchanged; zero
  production imports of `v14` seam.

## Holdout declaration
Holdout **NOT evaluated**. `policy_lock.locked_variant == null`; variant runs
contain no holdout rows (V14R-SAF assert); no retuning occurred.

## CI proof
- Workflow `CI`, run **31316985697** (https://github.com/titostream27/youtube-content-miner/actions/runs/31316985697): jobs `test` + `v14r-evidence-gate` = **success** (blocking G9).
- Windows local: same numbers in `test_report.json` (48 files/343 tests; verifier 12/12; checksums 76/76).

## Remaining limitations (honest)
- The FAIL audit judge (C) contradicted A/B on 4/7 cases — those became
  REVIEW, never PASS; the difference is transparent and versioned.
- Re-run of the census would change `acquired_at` → census excluded from the
  immutable manifest (documented).
- The four REVIEW flips do not change the BLOCKED verdict or any safety row
  (none of the 4 are accepted under any variant).

## Next step (separate authorization required)
V15 brief on START semantics: restated-question detection, referent
restoration, discriminative evidence for the 0.78–0.82 ending cluster. V15
must reuse the frozen benchmark and must NOT view the sealed holdout until
exactly one policy is locked.