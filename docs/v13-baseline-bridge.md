# V13 Baseline Bridge

**Date:** 2026-08-09
**Brief:** `Brief_V13_Production_Selector_Alignment_Silver_Pass_Recall.pdf`
**Explicit statement:** V12/V12R work is not being repeated. This document references accepted artifacts and records the exact state V13 starts from.

## 1. Repository state (Phase A.1)

| Item | Value |
|---|---|
| Worktree | `youtube-content-miner-v13-selector` (new) |
| Branch | `fix/brief-v13-selector-alignment` |
| Base SHA | `1f58c6f3` (V12R `fix/brief-v12r-silver-gold-judge`) |
| PR | #7 open, mergeable=clean, head=`fix/brief-v12r-silver-gold-judge` |
| GitHub Actions | `1f58c6f3` succeeded (CI GREEN); `cdaeffb8` failure (mid-sprint commit), `0b6f532`/`d8bd2a6` green |
| Baseline CI (local) | Vitest **44 files / 305 tests passed**, tsc **0 errors**, eslint **0 warnings** |
| Remarks | V13 work is committed on top of `1f58c6f3`; V12R evidence preserved untouched under `evidence/v12r/` |

## 2. Frozen corpus (A.3 — unchanged)

10 episodes in `content-miner/data/content-miner.db` (read-only; `youtube_asr`, cue-level timing; transcript SHA-256 per episode recorded in `docs/v12-baseline-audit.md` §3). Verified present via `getTranscript` for all 10 ids; episode identities unchanged.

## 3. V12R judge configuration (A.4, unchanged)

| Tier | Judge | Provider/endpoint | Model family |
|---|---|---|---|
| A | `ds/deepseek-v4-flash` | 9router 127.0.0.1:20128/v1 | DeepSeek |
| B | `google/gemini-2.5-flash-lite` | OpenRouter API | Google |
| C | `cx/gpt-5.6-luna` | 9router 127.0.0.1:20128/v1 | OpenAI GPT |

Independence tier: **Good+** (three model families, two provider endpoints; A/C share the gateway, different families and materially different prompts). Judge runner reads explicit `V12R_JUDGE_<tier>_{PROVIDER,MODEL}` env, stays independent of the production selector (R4).

## 4. Production configuration snapshot (A.5/A.6)

Full snapshot: `evidence/v13/config_before.json` (selector version, candidate generation, durations, START_GATE/ENDING_COMPLETE/ENDING_CONFIDENCE/contamination config, scoring weights, acceptance threshold, dedupe/ranking, fallback, LLM/provider identifiers — no secrets). Key values:

| Key | Value |
|---|---|
| min/max duration | hard min 14 / hard max 60s (`CLIP_HARD_MIN_SEC=14`, `CLIP_HARD_MAX_SEC=60` default; prod .env `SEGMENT_MIN_SEC=15`, `SEGMENT_MAX_SEC=90`) |
| ENDING_CONFIDENCE | 0.82 (`HIGHLIGHT_MIN_ENDING_CONFIDENCE`, default) |
| CONTAMINATION | max 0.18, lookahead 12s, end guard 0.2s |
| START_GATE | hard issues MID_SENTENCE / MISSING_CONTEXT / UNRESOLVED_REFERENCE; LATE_HOOK = penalty |
| scoring | drivers top-2 share 0.55, gates share 0.45 (standalone 0.4 / clarity 0.3 / hook 0.3) |
| acceptance | clip threshold 70 (`CLIP_SCORE_THRESHOLD=70` in prod env; `LIBRARY_MIN_SCORE=70`) |
| dedupe | candidate fingerprint + greedy non-overlapping at proposal |
| fallback | heuristic engine when LLM unavailable (engine observed "heuristic" in V12 runs) |

## 6. V13 status at this document's writing

Phases A (this doc) and B (consensus hardening, re-consensus executed) complete. Phase C expansion judge run executing (background). Phase D-H scripts ready (`scripts/v13-*.ts`; `src/lib/v13r/`).