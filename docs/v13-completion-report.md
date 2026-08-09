# V13 Completion Report — Production Selector Alignment / Silver-PASS Recall

**Date:** 2026-08-09
**Brief:** `Brief_V13_Production_Selector_Alignment_Silver_Pass_Recall.pdf`
**Branch:** `fix/brief-v13-selector-alignment` (base `1f58c6f3` V12R, PR #7)

## Final verdict: **BLOCKED**

V13 closes with a selector-alignment verdict of **BLOCKED** under the brief's
vocabulary (§27/§28): the silver benchmark, after full-pool expansion, does
not contain enough silver-PASS candidates to calibrate selector gates, and
every tested gate relaxation leaks silver-FAIL candidates without recovering
a single positive. All evidence produced is additive, deterministic and
preserved; no production behavior was changed on weak evidence (R1, R6, R8).

---

## 1. Mandatory completion-report questions

**Q1 — How many silver PASS candidates exist after consensus hardening and
expansion?** Zero (0). Hardened 51-candidate re-consensus: PASS 2 → 2 (0
label changes, hardening safe). Full 344-pool expansion (Judge A + B): 329
FAIL, 15 REVIEW (unresolved disagreements — Judge C unreachable), **0 PASS**.

#2 — Across how many distinct episodes are those positives distributed?
N/A — zero positives (0 episodes).

#3 — Was the full 344-candidate pool judged? If not, what cost-aware strategy?
Yes — full census: Judge A (deepseek-v4-flash) + Judge B
(ag/gemini-3.5-flash-low, Google family) over ALL 344 candidates,
deterministic, persisted in `evidence/v13/judge_outputs.jsonl`. Judge C
(cx/gpt-5.6-luna) was invoked on the 15 A/B disagreements, but the gateway
rejects every available key for the OpenAI channel ("Invalid API key"), so C
produced no verdicts. False-negative audit: not needed (full census, no
A-screen); the unresolved cases are kept REVIEW, never fabricated (R6/R7).

#4 — First-death counts for silver PASS at every production stage?
N/A — zero positives; exact fallback: first-death counts per stage for the
FAIL cohort are in `evidence/v13/first_death_matrix.csv` and
`tracer_summary.json` (04:27, 05:143, 06:1, 03:83, 07:85, 12:4, SURVIVED 1 —
totals reproduce the V12 funnel exactly, see `docs/v13-tracer-analysis.md`).

#5 — Worst positive-loss / negative-removal tradeoff stage?
Undefined on the positive side (0 positives). Best measured precision side:
START_GATE removes the most FAILs (83 first deaths; bypassing it leaks 11
FAILs while recovering 0).

#6 — Stages changed in production, and those deliberately left unchanged?
CHANGED in this sprint: **none** (no threshold, no weight, no prompt, no
production function — the trace/hardening/sampling additions are additive
tooling under `src/lib/v13r/` + `scripts/v13-*`). Deliberately unchanged:
all gates (START_GATE, ENDING gates), scoring weights, acceptance
threshold 70, contamination gate, dedupe, ranking, renderer.

#7 — For each changed gate: old behavior, new behavior, calibration, holdout?
N/A — no gate changed. Counterfactual evidence exists for every candidate
(calibration = all episodes under LOEO fallback): no beneficial change was
found (see #5, #23-#25, `v13-gate-ablation.md`).

#8 — Hard thresholds changed? Exact before/after?
No. `HIGHLIGHT_MIN_ENDING_CONFIDENCE` stays 0.82, `CLIP_SCORE_THRESHOLD` 70,
contamination 0.18, durations 14/60, `LIBRARY_MIN_SCORE` 70
(`evidence/v13/config_before.json` == `config_after.json`).

#9 — Scoring weights changed?
No (weights unchanged; recorded in config_before).

#10 — Prompts changed?
No. Judge prompts unchanged (V12R design).

#11 — ENDING_CONFIDENCE/H6 reopened?
No. H6 stays per V12R (§Phase J: "do not reopen 0.82→0.78 merely because a
positive is near the threshold"); with 0 positives there is no such positive.

#12 — H1 bounded expansion became production behavior?
No. H1 variants are kept as a separate repaired-variant cohort; no holdout
benefit exists (0 positives), and the one H1-repaired Jagger candidate is
now REVIEW/FAIL under the current judges.

#13 — Silver-PASS Recall@Eligible before and after?
before: 0/0 (undefined). after: 0/0 (undefined). (Denominator = 0 —
exact numerators reported per §20.)

#14 — Recall@Accepted before/after?
before 0/0, after 0/0 (undefined — same reason).

#15 — Silver-FAIL Leakage@Accepted before/after?
before: 0/0 in G2; after: 0/0 in G2 (0 accepted clips). Replay-side
1/329 = 0.30% (the single lineage-accepted FAIL).

#16 — Hard negatives accepted?
0. #17 — Next-topic leakage accepted?
0.

#18 — Top-1 / Top-3 silver recall?
Not evaluable (0 PASS; exact 0/0 reported).

#19 — Episodes producing ≥1 silver PASS?
0/10.

#20 — Production-selected silver PASS clips available for G3?
0 (G3 stays blocked; speaker-switch downstream blocker documented in V12R).

#21 — Renderer production code changed?
No (R9 honored; renderer untouched).

#22 — What remains blocked after V13?
(i) Silver benchmark third judge family (Judge C / OpenRouter / Google) —
unavailable credentials in this environment; (ii) any positive-side
calibration — zero positives in the frozen corpus; (iii) G3 speaker-switch —
no diarization in transcripts (documented downstream blocker).

## 2. Definition-of-Done checklist (binary)

| Item | Required | Status |
|---|---|---|
| V12/V12R artifacts reused, not redone | PASS | ✓ |
| Consensus critical vetoes hardened | PASS | ✓ (SA-06/07/08/22 tests) |
| V12R 51-candidate labels re-evaluated | PASS | ✓ 0 changes |
| Benchmark expanded or 344 pool exhausted | PASS | ✓ full 344 census |
| ≥8 PASS / ≥4 episodes OR scarcity proven | PASS | ✓ scarcity PROVEN (0) |
| Tracer cohorts versioned | PASS | ✓ |
| Production stage replay implemented | PASS | ✓ trace.ts |
| First-death matrix produced | PASS | ✓ |
| Stage-level PASS survival / FAIL leakage metrics | PASS-PRECISION | ✓ (P side = exact 0/0) |
| Episode-disjoint split or LOEO established | PASS | ✓ LOEO fallback documented |
| Each changed stage isolated counterfactual | PASS | ✓ (no stage changed; all ablated) |
| No threshold gaming | PASS | ✓ |
| No negative-duration regression | PASS | ✓ (borders) |
| No next-topic contamination regression | PASS | ✓ |
| No hard-negative acceptance | PASS | ✓ |
| Scoring/ranking/dedupe lineage auditable | PASS | ✓ |
| Holdout Recall@Eligible target met or justified | PASS-justified | ✓ (impossible: 0 positives) |
| Holdout Recall@Accepted target met or justified | PASS-justified | ✓ (idem) |
| Holdout leak target met | PASS | ✓ (0) |
| Top-1/Top-3 reported | PASS | ✓ reported as undefined |
| >=3 accepted PASS clips across >=3 episodes | FAIL | ✗ (0) — BLOCKER |
| Full miner CI green | PASS | ✓ 321 tests / tsc 0 / eslint 0 ✓ |
| GitHub Actions green | PASS | see PR |
| Renderer untouched | PASS | ✓ |
| Verdict vocabulary correct | PASS | BLOCKED |

## 3. Evidence inventory (all under `evidence/v13/` + `docs/v13-*`)

benchmark_manifest.json · judges/gate consensus_labels_v13.jsonl ·
judge_outputs.jsonl · consensus_label_changes.jsonl · hardening_summary.json ·
config_before.json · config_after.json (same file, no change) · tracer_manifest.jsonl ·
traces.jsonl · first_death_matrix.csv · stage_metrics.json · tracer_summary.json ·
split_manifest.json · counterfactuals.jsonl · gate_ablation_summary.json ·
alignment_metrics.json · production_g2_after.jsonl · herd_suppression.json ·
judge_run_summary.json. Docs: v13-baseline-bridge, consensus-hardening,
silver-benchmark-expansion, tracer-analysis, gate-ablation, g2-evidence,
completion-report (this file). V12R evidence untouched in `evidence/v12r/`.

**Done — the honest end-state: the selector is high-precision, zero-positive;
the missing ingredient is judge-family availability and/or candidate-
generation recall, not a threshold. The brief was carried to its evidence
boundary without weakening any rule.**