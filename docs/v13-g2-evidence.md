# V13 Production G2 Evidence (Phase U)

**Date:** 2026-08-09

## Run

`scripts/v13-g2.ts` over the 10 frozen episodes with the SAME production
functions used by the V12 lineage eval (`detectMoments` →
`twoPassHighlightSelection` → heuristic scoring → clip threshold 70),
`AI_PROVIDER=heuristic` (deterministic; the engine observed in V12 runs),
silver labels from the hardened v13.0 consensus.

Evidence: `evidence/v13/production_g2_after.jsonl`, `production_g2_after_summary.json`,
`alignment_metrics.json`.

## Per-episode funnel

| episode_id | raw candidates | eligible (kept) | accepted | accepted silver PASS | accepted silver FAIL |
|---|---|---|---|---|---|
| I6wCuvvaRPI | 1993 | 1 | 0 | 0 | 0 |
| GOqEl4ADyVk | 1920 | 0 | 0 | 0 | 0 |
| 2HLGcRpw1hc | 635 | 0 | 0 | 0 | 0 |
| UZ1kCEGjYX0 | 674 | 0 | 0 | 0 | 0 |
| Hb2rKGfIOrM | 83 | 0 | 0 | 0 | 0 |
| g2cQ2kD6lzs | 328 | 1 | 0 | 0 | 0 |
| Ive926sC6mc | 2695 | 0 | 0 | 0 | 0 |
| 3NSC5nps3OM | 3436 | 1 | 0 | 0 | 0 |
| 376JmatmnaI | 374 | 0 | 0 | 0 | 0 |
| XuoqKYxDHVc | 326 | 0 | 0 | 0 | 0 |

(raw = enumerated candidates before greedy non-overlapping selection;
eligible = candidates surviving the two-pass gates.)

Totals: 10/10 episodes OK, **0 negative durations**, 0 accepted clips,
0 hard negatives accepted, 0 next-topic leakage accepted.

## Selector-recovery metrics (same benchmark v13.0, BEFORE == AFTER)

| Metric | BEFORE | AFTER | Target | Status |
|---|---|---|---|---|
| Silver-PASS Recall@Eligible | 0/8 (0%) | 0/8 (0%) | ≥80% | ✗ — 7/8 die at 05 (conf 0.78 class-constant), 1/8 at 04 |
| Silver-PASS Recall@Accepted | 0/8 (0%) | 0/8 (0%) | ≥70% | ✗ — no clip reaches scoring |
| Silver-FAIL Leakage@Accepted | 0/0 | 0/0 | ≤10% | ✓ (0 accepted clips in G2) |
| Hard-negative acceptance | 0 | 0 | 0 | ✓ |
| Next-topic leakage acceptance | 0 | 0 | 0 | ✓ |
| Top-1 silver recall | n/a | n/a | ≥60% | not evaluable (no accepted clip) |
| Top-3 silver recall | n/a | n/a | ≥80% | not evaluable |
| Episodes with ≥1 accepted PASS | 0/10 | 0/10 | ≥3 | ✗ |

No production code path changed in V13 (evidence-backed tuning impossible
below the sufficiency gate: 8 PASS across 3 episodes, §5.1; single-gate
ablations recover nothing — see `v13-gate-ablation.md`).

## Replay-side note

The stage replay (deterministic trace) accepts exactly one candidate in the
lineage — the Iqbal clip (`c=3b416b15c9b5`, score 80) — which the silver
benchmark labels FAIL. This is the "Iqbal-Z ACCEPTED with silver FAIL"
leakage case from the brief's example matrix; it is recorded in
`first_death_matrix.csv` and blocks FEATURE-READY (SA-24) until explained:
the judges' `publishable=false` (A: false, B: false) contradicts the
production acceptance. No production change was made to mask it.

## G2 selector-recovery verdict

**BLOCKED** — see §28 stop conditions: benchmark insufficient (0 silver
PASS after full-pool expansion; third judge family unreachable in this
environment), and no gate relaxation recovers a positive while several leak
FAILs (START 11, ACCEPT 4). Deliverables and the completion report follow.