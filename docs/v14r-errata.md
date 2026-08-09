# V14R Errata — corrections to the V14 closure

This errata identifies every verified false or unverifiable statement in the V14
closure and its repair. It is authoritative over `docs/v14-completion-report.md`
(which is superseded for any claim that contradicts artifacts).

## F-01 (P0) — false leakage claim for E3
- **V14 report said**: "Next-topic leakage accepted (new) | 0 … YES"
  (metrics table row 4).
- **Artifacts say**: raw `runs/E3/E3/variant_results.jsonl` + `policy_lock.json`
  → E3 newly accepts **2 next-topic-leakage-flagged candidates**:
  `c=9e121d6b7221`, `c=fb53d482602c` (both also silver FAIL and
  hard-negative-flagged).
- **Resolved by**: `evidence/v14r/policy_reconciliation.json` (lock equals
  recompute 2/2/2), `evidence/v14r/report_claims.json` (REC-E3-FAIL/HN/LK = 2),
  and `scripts/v14r-reconcile.ts`. The V14 verdict (BLOCKED) is **unchanged and
  strengthened** by this correction (leakage was worse than reported).

## F-02 (P0) — 7 of 90 published checksums failed on a Linux checkout
Failing paths (git-blob hash ≠ published):
`baseline.json`, `candidates.csv`, `episode_manifest.csv`,
`metrics_aggregate.json`, `new_manifest.json`, `production_diff.txt`,
`sha256sums_v13_artifacts.txt`.
Causes: CRLF bytes at hash time for six Python-written files (line-ending
drift), and a stale-content manifest for `production_diff.txt` (regenerated
after the manifest was built). Full mapping in
`evidence/v14r/checksum_reconciliation.json` + `old_checksum_failures.json`.
Repair: LF-canonical immutable manifest `evidence/v14r/SHA256SUMS`
(76 entries, 100% pass on Linux and Windows).

## F-003 (P0) — case-sensitive path breakage
`scripts/v14-verify.ts` constructed `runs/e3/E3` / `runs/c0/C0` by hand while
committed dirs are `runs/E3/E3` and `runs/c0/C0`; on case-sensitive Linux the
e3 path fails (ENOENT). Repair: canonical map `src/lib/v14/artifact-paths.ts`,
used by every script (`V14R-PATH-001..005` tests).

## F-004 (P0) — non-fail-closed loaders
`scripts/v14-select.ts` read `c0/C0` via joined string and returned `[]` on
missing inputs. Repair: `requiredRunFile`/`loadJsonlStrict` throw on
missing/empty/malformed (`V14R-PATH-003/004` tests), candidate census = 424
asserted per variant.

## F-05 (P1) — CI did not run the evidence gate
Repair: `.github/workflows/ci.yml` job `v14r-evidence-gate` (ubuntu-latest,
blocking, after the unit job) runs `npm run verify:v14r` and the Node checksum
validator; no secrets, no provider calls.

## F-06 (P1) — frozen-protocol FAIL audit was absent
Repair: `evidence/v14r/fail_audit_sample.json` (deterministic positions
20,40,…,140 of the 150 byte-sorted FAIL ids), `fail_audit_judge_outputs.jsonl`
(7/7 ok, blinded Judge C), `consensus_labels_v14r.jsonl`,
`label_errata_v14r.jsonl`. Result: 3 retained FAIL, 4 → REVIEW (contradicted
A/B ); nothing forced to PASS.

## F-07 (P1) — verifier passed SAFETY unconditionally
Repair: `V14-SAF-001` now recomputes safety from raw outcomes and compares to
`policy_lock.json`; `v14r-verify.ts` re-checks per variant and fails on any
mismatch (V14R-SAF-001 + V14R-REC-001/002).

## F-08 (P1) — immutable manifest included mutable output
`evidence/v14/SHU256SUMS` hashed `run_summary.json` (written_at),
`verification_report.json` (generated_at) and `census_new.jsonl`
(acquired_at). Repair (R-03): the V14R manifest excludes itself, all
`run_summary.json`, `verification_report.json` and `ci_run_metadata.json`;
`verification_report.json` is deterministic (no timestamps) but kept out of
the immutable set because it is self-referential.

## Scope guard
No production selector semantic, default, threshold, recording, or holdout
behavior was changed under V14R. Holdout remains sealed; `locked_variant` is
still `null`.