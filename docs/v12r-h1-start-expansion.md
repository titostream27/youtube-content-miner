# V12R H1 Counterfactual — Valid-Setup Start Expansion

**Date:** 2026-08-08
**Brief section:** Phase J (§13); regression matrix AJ-10..AJ-15
**Verdict: NOT PROMOTED — KEEP EXPERIMENTAL.**

## 1. Question

Can bounded, deterministic start expansion convert silver-negative
mid-context starts into silver-positive standalone candidates without
dragging in the previous topic?

## 2. Method (shortcut forbidden: no fixed N-second prepend)

For every sampled `FINALIZE_START_GATE` reject (plus top-ranked candidates):

1. Detect mid-context starts with semantic + deterministic cues.
2. Search backward ONLY within a bounded window (≤40 s), snapping to
   utterance boundaries, preferring question → referent setup → sentence
   start → topic setup, in nearest-first order.
3. Reject expansion when it would cross a topic-transition marker, exceed
   the 60 s hard max, or find no valid setup.
4. Re-judge repaired windows through the A/B/C silver consensus
   (`--judge` mode) and compare with the original silver label.
   Evidence: `evidence/v12r/h1_counterfactual.jsonl` (14 rows).

## 3. Results

| Metric | Value |
|---|---|
| Candidates analyzed (start-gate stratum) | 14 |
| Expansions found | 9 (all `EXPAND_TO_SENTENCE_START`) |
| Rejections | 5 (`REJECT_DURATION_LIMIT`) |
| Crossed-topic rejections | 0 |
| Re-judged through A/B/C consensus | 9 |
| …of which became silver **PASS** | **1** (`c=7d4430531900`, Jagger episode, 48.48 s) |
| …still FAIL after expansion | 7 |
| …REVIEW after expansion | 1 |
| Silver-negative → PASS (false promotion) | 0 |

## 4. Interpretation and decision

- The heuristic is deterministic and safe (0 topic crossings, 0 duration
  violations, 0 false promotions).
- But it recovers only **1 candidate in 1 episode** out of 14 analyzed —
  below "multiple frozen episodes benefit" (Phase L criterion #3).
- 7 of 9 expansions re-judge as FAIL: the mid-context start was not the
  real defect — the underlying windows are semantically weak even when
  starts are repaired.

**Decision: KEEP EXPERIMENTAL.** No production start logic was changed.
The expansion module remains available as infrastructure; promotion requires
stronger evidence (e.g., a transcript corpus with speaker/pause metadata and
a human gold set).

## 4. Regression fixtures

AJ-10 (expands to question), AJ-11 (no setup → reject), AJ-12 (crossing
topic → reject), AJ-13 (valid start → no expansion), AJ-14 (combined
invariants), AJ-15 (judge hints advisory — consensus never consumes
`repair_hint` timestamps) are covered in
`src/lib/v12r/__tests__/v12r-fixtures.test.ts`.