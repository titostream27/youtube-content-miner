# V13 Tracer & First-Death Analysis (Phases D/E/F)

**Date:** 2026-08-09

## Methodology

- Cohorts are built from the hardened V13 consensus labels: **P = PASS (0)**,
  **N = FAIL (329)**, **R = REVIEW (15)**. Every lineage candidate was traced
  (344/344; all 10 frozen episodes).
- `src/lib/v13r/trace.ts` replays each candidate through the REAL production
  functions in production order: temporal normalization (deterministic
  boundary refinement) → END gates first (`validateBoundary` order with the
  single `repairBoundary` attempt on ANY failure, repaired boundaries
  adopted) → START gate (`finalizeCandidate` semantics: start validation +
  bounded repair) → scoring (heuristic, deterministic) → ranking →
  acceptance threshold → final accepted.
- Every trace emits all 14 canonical stages (SURVIVED / DIED / NOT_REACHED),
  so no stage is ever silently skipped.
- Artifacts: `evidence/v13/traces.jsonl`, `tracer_manifest.jsonl`,
  `first_death_matrix.csv`, `stage_metrics.json`, `tracer_summary.json`,
  `herd_suppression.json`.

## First-death distribution (FAIL cohort, N=329)

| First-death stage | Count | Share | Notes |
|---|---|---|---|
| 04_ENDING_COMPLETE | 27 | 8.2% | production ENDING_COMPLETE (53) splits 23@04 + others (see cross-check) |
| 05_ENDING_CONFIDENCE | 143 | 43.5% | dominant killer; production ENDING_CONFIDENCE 154 — most attributed here |
| 06_CONTAMINATION_GATE | 1 | 0.3% | matches the single V12 contamination fixture |
| 03_START_GATE | 83 | 25.2% | production FINALIZE_START_GATE 112 — 76 directly at START, rest later at end gates |
| 07_DURATION_GATE | 85 | 25.8% | production MIN_DURATION 22 + ends that production repair-attributed |
| 12_ACCEPTANCE_THRESHOLD | 4 | 1.2% | 1 = the SCORING row; rest near-threshold |
| SURVIVED | 1 | 0.3% | the single production-accepted candidate (Iqbal, score 80) |

Cross-check vs the frozen V12 funnel (rejection stages):

| V12 lineage stage | Count | Trace attribution (sum) |
|---|---|---|
| ENDING_CONFIDENCE | 154 | 121@05 + 28@07 + 4@03 + 1@04 = 154 ✓ |
| FINALIZE_START_GATE | 112 | 76@03 + 21@05 + 10@07 + 3@04 + 2@12 = 112 ✓ |
| ENDING_COMPLETE | 53 | 23@04 + 27@07 + 2@03 + 1@12 = 53 ✓ |
| MIN_DURATION | 22 | 20@07 + 1@05 + 1@03 = 22 ✓ |
| NEXT_TOPIC_CONTAMINATION | 1 | 1@06 ✓ |
| SCORING | 1 | 1@12 ✓ |
| KEPT (accepted) | 1 | SURVIVED ✓ |

The trace engine reproduces the production funnel totals exactly; individual
attribution can shift stage (e.g. an ENDING_CONFIDENCE lineage kill reports
as 07 when the repair fixed the ending but the repaired window is still too
short).

## Silver-PASS survival / first-death (P cohort)

**Denominator is zero** (0 PASS candidates in the final two-judge
consensus). Per brief §20 + Phase F §8.1: percentages are not computed;
exact numerator/denominator reported. No gate can be blamed for "killing a
silver positive" because no candidate carries a positive label.

## Herd / overlap suppression (Phase M evidence)

`herd_suppression.json` lists overlap pairs with ≥1s overlap:
- 54 overlapping pairs among traced windows;
- suppression lineage (`suppressed_by_candidate_id`, scores, silver labels)
  is recorded. No PASS was suppressed (no PASS exists).

## Interpretation

The selector kills in the same places the V12 funnel described: ending-side
confidence and completeness, then starts, then duration. But with a zero
positive set, these numbers only measure **precision-side** behavior — which
is high (1/329 replay-eligible leak; 0 accepted in the production G2 run).