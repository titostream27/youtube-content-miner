# V13 Gate Ablation (Phase H) & Scoring/Ranking Analysis (Phase L/M)

**Date:** 2026-08-09 (rev. 2 — after Judge C fix; benchmark now 8 PASS / 333 FAIL / 3 REVIEW)

## Counterfactual protocol

One gate bypassed at a time; every other gate stays active; threshold
variants tested separately (ending_conf 0.80 / 0.78, contamination 0.25).
The episode-disjoint split (hash 70/30, stored before tuning — SA-13) gives
7 calibration episodes (3 PASS: GOqEl×1, g2cQ×2) and 3 holdout episodes
(5 PASS: I6wCuvvaRPI×5).

Evidence: `evidence/v13/counterfactuals.jsonl`, `gate_ablation_summary.json`,
`attribution_staircase.jsonl`.

## Results (calibration episodes, 225 rows)

| Bypassed stage | Recover silver-PASS | Leak silver-FAIL |
|---|---|---|
| 03_START_GATE | 0 | 14 |
| 04_ENDING_COMPLETE | 0 | 0 |
| 05_ENDING_CONFIDENCE | 0* | 1 |
| 06_CONTAMINATION_GATE | 0 | 0 |
| 07_DURATION_GATE | 0 | 0 |
| 12_ACCEPTANCE_THRESHOLD | 0 | 4 |

\* bypassing 05 lets calibration PASS candidates survive that gate, but they
are then killed at 03_START_GATE — a single relaxation alone cannot recover
a positive.

Threshold variants: ending_conf 0.78 → 1 FAIL leaks (no PASS recovered on
calibration); 0.80 and contamination 0.25 → no flips.

## Attribution staircase (8 silver-PASS)

`attribution_staircase.jsonl` replays each PASS under {none, only05, only03,
03+05, 03+05+12}:

| scenario | first death | accepted |
|---|---|---|
| none | 05_ENDING_CONFIDENCE (7×, conf=0.78 class constant) / 04 (1×) | no |
| only05 | 03_START_GATE | no |
| only03 | 05_ENDING_CONFIDENCE | no |
| 03+05 | 12_ACCEPTANCE_THRESHOLD (scores 63–69 < 70) | no |
| 03+05+12 | — | yes (score 63–69) |

The chain for every positive: **ENDING_CONFIDENCE (classifier-constant 0.78
floor) → START_GATE → acceptance threshold 70**. Each layer is necessary;
no single gate change recovers anything (R6: fix the earliest causal stage —
05 — but §5.1 forbids aggressive tuning while the benchmark has 8 PASS on
only 3 episodes).

## Bad-gate signature check (Phase F §8.1)

05_ENDING_CONFIDENCE shows the BAD GATE SIGNATURE: it kills 7/8 silver
positives (87.5%) while removing 153 FAILs — a very selective kill that
correlates with the judge label. The defect is that the killer is the
*classifier's own constant* (0.78) rather than graded evidence; the fix is a
Phase-J formulation change (separate low evidence from evidence of
incompleteness), not a threshold nudge.

## Scoring / ranking analysis (Phase L/M)

- The single lineage-accepted candidate (Iqbal `c=3b416b15c9b5`, score 80)
  remains silver-FAIL (SA-03/SA-24 trigger; documented, no masking).
- PASS candidates score 63–69 under the heuristic engine — below the 70
  acceptance floor; scoring alignment is part of the recommended follow-up.
- No scoring weight, formula, or threshold changed; config_before ==
  config_after (same benchmark v13.0).

## Decision (Phase I-N gate repair)

- NO production threshold/weight/prompt changed (R1, R6, §5.1: sufficiency
  gate unmet — 8 PASS / 3 episodes; no holdout-validated single change).
- H6 not reopened as production behavior; the 0.78 cluster is reported as
  the Phase-J fix candidate with full tracer evidence.
- H1 stays non-global.
- The recommended next sprint: (a) complete-ending classes must not
  hard-reject (confidence floor applies to *evidence strength*, not to
  semantic completeness); (b) START_GATE penalty audit for complete
  windows; (c) score alignment — each gated on a ≥4-episode benchmark.