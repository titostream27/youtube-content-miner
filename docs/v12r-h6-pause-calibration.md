# V12R H6 Counterfactual — Pause-Aware Ending Confidence

**Date:** 2026-08-08
**Brief section:** Phase I (§12); regression matrix AJ-08/AJ-09
**Verdict: NOT PROMOTED — KEEP EXPERIMENTAL (unresolved).**

## 1. Question

Are many `ENDING_CONFIDENCE` rejects (0.78 cluster) independently judged
semantically complete and publishable? If yes, calibration has evidence. If
no, moving 0.82 toward 0.78 is threshold gaming (R2).

## 2. Method (shortcut forbidden: no blanket threshold change)

1. For every candidate with an ending-confidence reject, computed
   pause/semantic features from the frozen-corpus utterances:
   `pause_after_end_ms`, `speaker_change_after_end`,
   `semantic_closure_features`, `next_topic_features`.
2. Derived `experimental_confidence` that:
   - adds pause/speaker/closure bonuses when safe,
   - clamps to ≤ 0.45 for dangling or question endings (AJ-09),
   - subtracts 0.2 when the next utterance opens a new topic/question.
3. Compared experimental decision (≥ 0.82 accept) with the silver-gold
   consensus label for sampled candidates.
   Evidence: `evidence/v12r/h6_counterfactual.jsonl` (156 rows).

## 3. Results

| Metric | Value |
|---|---|
| Candidates analyzed | 156 (all ENDING_CONFIDENCE rejects + scored candidates) |
| Pause ≥ 250 ms after end | **4 / 156 (2.6%)** |
| Pause ≥ 500 ms after end | 4 / 156 |
| Speaker change after end | **0 / 156** (cue-level transcripts carry no speaker IDs) |
| Punctuation: sentence_end / question_end / none | 66 / 66 / 24 |
| Dangling (unfinished) endings | 9 |
| Next-topic signal (question/transition after) | 16 |
| Experimental recoveries (REJECT→ACCEPT) | **0** |
| Experimental false promotions (ACCEPT on silver FAIL) | **0** |

## 4. Why there is no recovery evidence

The frozen corpus is cue-level ASR without word timing; pause features are
almost entirely absent (only 4/156 utterances have a ≥250 ms pause after the
window). The 0.78 cluster is the deterministic `CONCLUSION`/`ANSWER_COMPLETE`
confidence on punctuation-less transcript endings — there is simply no
discriminative pause/speaker signal to calibrate against. Boosting 0.78→0.82
without that signal would be threshold gaming: it would accept exactly the
same candidates the deterministic gate rejects, with no semantic basis.

## 5. Promotion decision (Phase L criteria)

| Criterion | Result |
|---|---|
| Recovers silver-positive candidates across multiple episodes | ❌ (0 recoveries) |
| Does not promote silver-negatives | ✅ (0 false promotions) |
| No contamination regression | ✅ |
| Temporal invariants preserved | ✅ (no production change) |
| Feature/formula change has regression tests | tests exist; formula NOT promoted |

**Decision: KEEP EXPERIMENTAL.** Production `HIGHLIGHT_MIN_ENDING_CONFIDENCE`
stays 0.82; no threshold was changed. Any future calibration must wait for a
transcript source with real pause/speaker evidence (finer ASR) or a human
gold set.