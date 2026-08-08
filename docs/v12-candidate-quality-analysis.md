# V12 Candidate Quality Analysis — Root Cause from Real Data

**Date:** 2026-08-08
**Method:** lineage instrumentation (`scripts/v12-lineage-eval.ts`) ran the exact production
functions (`detectMoments` -> `twoPassHighlightSelection` -> guards -> repair -> finalize) on the
frozen 10-episode corpus. No threshold was changed, no prompt was changed, no code semantics were
changed to produce these numbers. Raw evidence: `docs/evidence/v12-lineage.jsonl` (one row per
candidate), `docs/evidence/v12-lineage.stderr.log`.

## 1. Reproduction of the baseline

| episode | rough | kept | accepted |
|---|---|---|---|
| I6wCuvvaRPI (Kim) | 40 | 0 | 0 |
| GOqEl4ADyVk (Tom) | 40 | 0 | 0 |
| 2HLGcRpw1hc (Jagger) | 36 | 0 | 0 |
| UZ1kCEGjYX0 (Damon) | 39 | 0 | 0 |
| Hb2rKGfIOrM (Obama) | 14 | 0 | 0 |
| g2cQ2kD6lzs (Kobe) | 25 | 1 | 0 |
| Ive926sC6mc (Iqbal) | 40 | 1 | 1 |
| 3NSC5nps3OM (Idgitaf) | 40 | 0 | 0 |
| 376JmatmnaI (Millie) | 40 | 0 | 0 |
| XuoqKYxDHVc (Musk) | 30 | 0 | 0 |
| **Total** | **344** | **2** | **1** |

Identical to the V11 baseline (1 accepted: Iqbal 2097.48–2138.04, PUNCHLINE, score 80, start_complete=true).
Deterministic rerun (CQ-20): the rerun produced the same accepted candidate and the same kept set.

## 2. Rejection funnel (344 candidates)

| stage | count | share |
|---|---|---|
| ENDING_CONFIDENCE (0.78 < 0.82) | 154 | 44.8% |
| FINALIZE_START_GATE (start gate / empty slice / finalize reject) | 112 | 32.6% |
| ENDING_COMPLETE (incomplete sentence/filler/unresolved) | 53 | 15.4% |
| MIN_DURATION (< 14s after repair) | 22 | 6.4% |
| NEXT_TOPIC_CONTAMINATION | 1 | 0.3% |
| SCORING (kept but finalScore < 70) | 1 | 0.3% |
| KEPT (accepted) | 1 | 0.3% |

## 3. Root-cause verdicts (brief §2.1 hypotheses)

- **H6 — CONFIRMED (dominant):** 154/344 (44.8%) candidates are rejected at the same deterministic
  ending-confidence value, `0.78 < 0.82`. In `classifyEnding`, a sentence-ending utterance without a
  long pause after it yields `CONCLUSION` confidence 0.78; an ASR cue transcript without word timing
  makes the pause signal the only discriminative evidence. The ending detector is not unreliable at
  random — it is systematically below the configured threshold on punctuation-less podcast ASR.
- **H1/H2 (start) — CONFIRMED (second dominant):** 112/344 (32.6%) are rejected in
  `FINALIZE_START_GATE`. The boundary/ending gates passed; the deterministic `validateStartBoundary`
  then rejected the window opening (mid-sentence, missing context, or unresolved referent) and the
  finalize start-repair found no valid setup to expand to. These are candidates whose proposal window
  begins too late / mid-context (H1) or ends at a place where the next topic begins (H2), with H1
  being the larger share of the observed start-gate messages.
- **H3 — MINOR:** 53 (15.4%) ENDING_COMPLETE rejections; these are genuine incomplete endings, not a
  systematic early cut.
- **H9 — DISPROVEN as systemic:** only 1 NEXT_TOPIC_CONTAMINATION rejection across 344 candidates.
  The deterministic topic-transition guard works.
- **H4/H5 — NOT YET REACHABLE:** only 2 candidates survive to scoring, so scoring/ranking cannot be
  the dominant cause; they remain a residual risk, not the bottleneck.
- **H10 — MINOR:** 22 (6.4%) MIN_DURATION rejections; duration policy is not the bottleneck.
- **H7/H8 — ENVIRONMENT:** the runtime produced no provider-failure warnings in the stderr log; the
  effective semantic engine in this environment is the deterministic heuristic one (same behavior as
  the V11 evaluations). No evidence of provider flakiness in this run; the LLM path was not observed
  to be exercised (no agent warnings).

## 4. First-failure principle

Earliest causal stage for the two dominant losses:

1. **Ending confidence (stage: boundary validation)** — the semantic closure signal is too weak on
   cue-level ASR without word timing/pauses. Repairing later stages (scoring/ranking) cannot recover
   these 154.
2. **Start completeness (stage: proposal/finalize)** — the salience-window proposal starts windows at
   the high-salience point (often mid-answer), without including the setup that
   `validateStartBoundary` requires. Repairing ending or scoring cannot recover these 112.

## 5. What was NOT changed, and why

- Thresholds (0.82 ending confidence, 70 clip score) were NOT lowered. The brief forbids threshold
  gaming, and without the human gold set we cannot validate that a confidence recalibration (e.g.
  boosting CONCLUSION when a pause follows) produces *correct* acceptances rather than more
  false-positive clips.
- No prompt changes. The semantic proposal is the deterministic salience window in this environment;
  there is no prompt to adjust for the dominant losses.
- No CI weakening, no skips.

## 6. Required next step (blocking)

Per brief §26 Definition of Done, the human listening gold set (10 publishable + 10 hard negatives)
is mandatory before any semantic repair can be proven. It cannot be produced in this environment
without a human reviewer. Therefore:

- V12 diagnosis is complete and evidence-backed.
- The smallest-correct-layer repair (ending-confidence calibration with pause evidence; start
  expansion to valid setup) is specified in `docs/v12-g2-g3-continuation-plan.md` but remains
  **blocked on the gold set**.
- Regression fixtures for the confirmed failure modes are added in
  `src/lib/moments/__tests__/v12-candidate-quality-regression.test.ts` (CQ-01..CQ-20 matrix).