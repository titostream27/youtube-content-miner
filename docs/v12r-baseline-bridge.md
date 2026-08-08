# V12R Baseline Bridge

**Date:** 2026-08-08
**Brief:** `Brief_V12R_Automated_Quality_Judge_Recovery.pdf`
**Explicit statement:** **V12 diagnostic work is not being repeated.**

This document references (does not duplicate) the accepted V12 evidence and
records the exact baseline V12R starts from. Every check below was verified
live against the repositories on 2026-08-08.

## 1. Inherited V12 baseline

| Item | Value |
|---|---|
| PR | [PR #6](https://github.com/titostream27/youtube-content-miner/pull/6) `fix/brief-v12-candidate-quality` (open, mergeable_state=clean) |
| V12 SHA | `d8bd2a6` — CI **completed/success** (GitHub Actions, 2026-08-08T13:30:49Z) |
| V12R base | `fix/brief-v12r-silver-gold-judge` branched from `d8bd2a6` |
| Miner CI (V12) | Vitest 287, tsc 0, eslint 0 |
| Renderer CI (V11-recovery) | `5d91cbe` completed/success (AI-Youtube-Shorts-Generator) |
| Frozen corpus | 10 episodes (youtube_asr, cue-level timing), transcript SHA-256 recorded in `docs/v12-baseline-audit.md` |
| Lineage | `docs/evidence/v12-lineage.jsonl` — **355 lines = 344 candidate rows + 11 episode summary rows** (verified by live count; 344 matches the accepted V12 number) |
| Funnel | ENDING_CONFIDENCE 154 (44.8%), FINALIZE_START_GATE 112 (32.6%), ENDING_COMPLETE 53, MIN_DURATION 22, NEXT_TOPIC_CONTAMINATION 1, SCORING 1, KEPT 1 (accepted) |
| Hypothesis verdicts | H6 dominant (confirmed), H1/H2 second (confirmed), H9 disproven as systemic, H4/H5 not reached |
| Human gold | 0/10 — **replaced by automated silver-gold consensus per V12R** |
| CQ regressions | CQ-01..CQ-20 → 19 passing tests in `src/lib/moments/__tests__/v12-candidate-quality-regression.test.ts` (verified present) |

## 2. Current HEAD before V12R edits

- Miner worktree: `youtube-content-miner-v12-quality`, branch `fix/brief-v12r-silver-gold-judge`, clean at creation.
- Renderer worktree: `AI-Youtube-Shorts-Generator-v11-recovery`, branch `fix/brief-v11-renderer-recovery` HEAD `5d91cbe`.

## 3. What V12R adds (no V12 redo)

1. `src/lib/v12r/` — judge types/schema, judge input contract builder, independent prompts (A/B/C), judge runner, deterministic consensus, H6 pause-aware ending-confidence counterfactual, H1 bounded start-expansion counterfactual, stratified sampling.
2. `scripts/v12r-*.ts` — sample manifest, benchmark run, H6/H1/combined counterfactuals, G2 rerun.
3. `src/lib/v12r/__tests__/` — AJ-01..AJ-20 sanity/regression fixtures (18 tests).
4. Non-semantic transport fix: OpenAI-compatible transport now tolerates a trailing `data: [DONE]` SSE marker from the local 9router proxy and accepts an optional `extraBody` (both default-off, no production behavior change).
5. Evidence: `evidence/v12r/*` + `docs/v12r-*.md`.

## 4. Judge independence tier (Phase D)

| Tier | Judge | Provider/endpoint | Model family |
|---|---|---|---|
| A | `ds/deepseek-v4-flash` | 9router local gateway (127.0.0.1:20128/v1) | DeepSeek |
| B | `google/gemini-2.5-flash-lite` | OpenRouter API | Google Gemini |
| C | `cx/gpt-5.6-luna` | 9router local gateway (127.0.0.1:20128/v1) | OpenAI GPT |

Three different model families; two distinct provider endpoints (9router gateway + OpenRouter). A and C share the local gateway infrastructure but use different model families and materially different judge prompts (R5). This is the strongest tier available in this environment and is documented as **Good+** (three families, two providers), not Preferred (three independent providers).

## 5. Config snapshot used by the benchmark

- `DATABASE_PATH` = `content-miner/data/content-miner.db` (frozen corpus, read-only)
- `DEEPSEEK_BASE_URL` = `http://127.0.0.1:20128/v1` (host override of the container-only `host.docker.internal` value)
- `OPENAI_BASE_URL` = `http://127.0.0.1:20128/v1` (Judge C channel)
- `V12R_JUDGE_CONFIDENCE_FLOOR` = 0.5 (default)
- Sampling seed = 20260808, target 72 → **51 candidates, 10/10 episodes, all major failure classes**
- Stratification: accepted 1, kept_non_accepted 1, contamination 1, ending_confidence 0.78-0.82 cluster 16, ending_confidence other 1, start_gate 14, ending_complete 8, random_negative 6, per_episode 3.

## 6. Status of V12R phases at this document's writing

Phase A complete (this doc). Phases B-H in progress (benchmark run persisting `evidence/v12r/judge_outputs.jsonl`, `consensus_labels.jsonl`, `benchmark_metrics.json`). Phases I-L (H6/H1/combined counterfactuals, promotion decision) and N-R (G2/G3/CI) follow in the completion report.
