# V13 Gate Ablation (Phase H) & Scoring/Ranking Analysis (Phase L/M)

**Date:** 2026-08-09

## Counterfactual protocol

One gate bypassed at a time; every other gate stays active; threshold
variants tested separately (ending_conf 0.80 / 0.78, contamination 0.25).
Because the split fell back to leave-one-episode-out (0 silver PASS in the
70/30 partitions), every episode is treated as calibration for the ablation
(no tuning happens — the ablations were run to ATTRIBUTE, with holdout
deferred by the scarcity decision).

Evidence: `evidence/v13/counterfactuals.jsonl`, `gate_ablation_summary.json`.

## Results (344 candidates)

| Bypassed stage | Would recover silver-PASS | Would leak silver-FAIL |
|---|---|---|
| 03_START_GATE | 0 | **11** |
| 04_ENDING_COMPLETE | 0 | 0 |
| 05_ENDING_CONFIDENCE | 0 | 1 |
| 06_CONTAMINATION_GATE | 0 | 0 |
| 07_DURATION_GATE | 0 | 1 |
| 12_ACCEPTANCE_THRESHOLD | 0 | 4 |

Threshold variants:
- ending_conf 0.78: 1 FAIL candidate flips to ACCEPTED (leak), no PASS recovered.
- ending_conf 0.80 / contamination 0.25: no flips.

## Bad-gate signature check (Phase F §8.1)

The BAD GATE SIGNATURE is "a gate that kills many silver positives while
removing few silver negatives". With zero positives the signature cannot
fire for recall; the inverse side is measured: every relaxation leaks FAIL
candidates (START leaks 11). START_GATE is the strongest precision
protector, not a recall bottleneck. No gate shows a recall-side deficit.

## Scoring / ranking analysis (Phase L/M)

- The single accepted candidate (Iqbal `c=3b416b15c9b5`, score 80) is
  silver-FAIL: the ranking cannot be validated as "PASS outranks FAIL"
  because no PASS exists; the accepted-FAIL case is captured (SA-03/SA-24)
  and blocks feature-ready (Phase 24 checklist).
- No scoring weight was changed; no score formula was changed; no
  threshold was changed. All comparisons are reported on the same v13.0
  benchmark version (config_before == config_after).

## Decision (Phase I-N gate repair)

Per brief §28 (stop condition): "The 344 candidate pool contains too few
silver positives to calibrate selector gates" AND "any proposed gate
relaxation improves positive recall only by materially increasing
silver-FAIL leakage" — both fire. Therefore:

- NO production threshold is changed.
- NO scoring weight is changed.
- NO prompt is changed.
- H6 stays un-reopened (V12R result stands; no new tracer evidence for it).
- H1 stays non-global (its one repaired variant is a REVIEW/FAIL under the
  current judges; no holdout-verified benefit).
- The only safe, real improvement demonstrated by V13 is the observable:
  the pipeline-faithful TRACE tooling and the hardened consensus — both stay
  additive.

An honest opening is documented instead: the benchmark (2 families, no
accessible third judge, 0 PASS) cannot currently claim silver-positive
existence in the frozen corpus; the next step is either restoring a third
judge family (OpenRouter/Google credentials) or adding candidate-generation
recall before any selector tuning (§Phase O).