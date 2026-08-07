# Brief v8 Completion Report

## 1. Baseline and final SHAs

| Repo | Baseline (brief) | Final (this cycle) | Commits |
|---|---|---|---|
| youtube-content-miner | `72b7a1f` | `5c1c238` | 8 (incl. Phase 0 matrix) |
| AI-Youtube-Shorts-Generator | `655f5b7` | `a36eebf` | 9 |

Both working trees clean, `main`.

## 2. Finding verification table

| ID | Verdict | Evidence |
|----|---------|----------|
| R01 | FIXED (C02) | async route now declares RenderSubmissionResponse; API-01/02 TestClient green |
| R02 | FIXED (C04) | one canonical list via _canonicalize/_build_render_response; rendered==artifacts; ART-01/02 green |
| R03 | FIXED (C06) | persist failure mirrors durable state + persistence_degraded; STATE-01 green |
| R04 | FIXED (C07) | startup reconcile + worker startup in FastAPI lifespan; LIFE-01 green |
| R05 | FIXED (C07) | worker starts in lifespan → /readyz 200 on idle; LIFE-02 green |
| R06 | FIXED (C08) | readyz write-probe (temp table), structured sqlite metadata, no postgres:wal |
| R07 | FIXED (C02) | get_existing_request_result returns actual persisted state; API-04 green |
| R08 | FIXED (C02) | sync idempotent deserializes stored RenderResponse after restart |
| R09 | FIXED (C06) | success/error paths use job.update(); STATE-03 green |
| R10 | PARTIAL | lookup helpers audited; legacy fallback retained (V1 compat per brief) |
| M01 | FIXED (C10) | no slice(endIdx+1,endIdx+4) remains; MINER-01 source-guard green |
| M02 | FIXED (C10) | lookahead anchors to final end e / finalized.finalEndSec; MINER-02 green |
| M03 | FIXED (C10) | repaired endingById AFTER finalizeCandidate; MINER-03 green |
| M04 | FIXED (C10) | semantic inline start-repair removed; finalizeCandidate sole owner |
| E01 | FIXED (C12) | max-cardinality matching; greedy counterexample → 2 matches; EVAL-01 green |
| E02 | FIXED (C12) | nPositive/nHardNegative/nIgnored/nPredictions/nMatchedPositive; EVAL-02 green |
| V01 | FIXED (C14) | planner failure no longer silently swallowed; VIS-01 green |
| V02 | FIXED (C14) | production consumes ReframeResult.timeline; capture isolated; VIS-02 green |
| T01 | FIXED (C15) | full suite 147 passed x2, zero failures; SUITE-01 green |
| RT01 | BLOCKED (C17) | real-media 10-episode/3-render acceptance not executed; pipeline proven on local fixtures |

## 3. Changed files by commit

**Miner:**
- `15254b5` docs: Phase 0 verification matrix
- `d9ee797` test(miner): hardening-v8 lookahead source guards (C09)
- `8e528d5` fix(miner): two-pass lookahead + metadata + start-repair owner (C10)
- `3674482` test(miner): golden-v8 E01/E02 RED (C11)
- `5c1c238` fix(miner): metrics max-cardinality + denominators (C12)
- `(C17)` docs: runtime-evidence-v8.md/.json + this report

**Renderer:**
- `4b6844e` test(renderer): test_api_v8 (C01)
- `e80c1e4` fix(renderer): API contracts (C02)
- `d2627e2` test(renderer): test_artifact_v8 (C03)
- `a218100` fix(renderer): canonical artifact list (C04)
- `008311c` test(renderer): test_persist_v8 (C05)
- `ca590a8` fix(renderer): durable mirror + metadata (C06)
- `6611811` feat+fix(renderer): lifespan + readiness (C07+C08)
- `16cdbec` refactor(renderer): planner authority (C13+C14)
- `5304691` test(renderer): SQLite isolation full-suite (C15)
- `a36eebf` ci: pin miner 5c1c238 (C16)

## 4. Database / lifecycle compatibility

- Schema unchanged; `RenderJobStatusResponse` is additive (extra=forbid typed).
- `_async_jobs` entries may now carry `runtime_error` and `persistence_degraded`
  (diagnostic only — canonical state remains durable SQLite).
- Lifespan startup is additive; `__main__` still works (CLI launch path).

## 5. Exact test commands and results

- Miner: `npx vitest run` → **218 passed, 0 failed**; `npx tsc --noEmit` clean.
- Renderer Windows full discovered suite (`.venv\Scripts\python.exe -m pytest -q`):
  - Run 1: **147 passed, 42 subtests, 0 failed** (92.8s)
  - Run 2: **147 passed, 42 subtests, 0 failed** (92.7s)

## 6. CI status and pinned contract SHA

- Renderer CI pins miner `5c1c23849ae7c837a85a53377a617ffe99843cca` (C16).
- Push pending at time of writing (token-redacted URL used in prior cycles).

## 7. Real-media evidence summary

- Episode count: **0 real episodes evaluated** (G1 not executed).
- Top-3 hit rate / boundary correction distribution / contamination: N/A.
- 3 final renders produced from local fixtures (see runtime-evidence-v8.md):
  h264 1080x1920 MP4s; real FFV1 intermediate + H.264 final encode.

## 8. Failure / restart / idempotency scenario outcomes

Covered by committed tests (not live-server runs):
- Invalid source/download → durable failed, publishable=false (existing v5/v6 tests).
- Multi-clip partial_failure → only ok artifacts publishable (ART-02, v7 tests).
- Restart orphan reconciliation → LIFE-01 TestClient lifespan test.
- Idempotent completed after memory reset → API-03/04.
- Queue-full admission → queue tests green.

## 9. Remaining known risks

- Real 10-episode intelligence acceptance (G1) not executed — needs real URLs + ASR.
- Caption word-timing sync on real captions not verified (part of G2).
- G3 live scenarios run as unit tests, not a live server + real download.
- `R10` legacy lookup fallback retained for V1 compat (documented, not deleted).

## 10. Rollback instructions

- **Miner:** `git reset --hard 72b7a1f` (pre-v8) or per-commit `git revert <sha>`.
- **Renderer:** `git reset --hard 655f5b7` (pre-v8) or per-commit revert.

## 11. Feature-readiness verdict

**READY WITH LIMITS**
- Code gates: all green (API, state truth, idempotency, lifecycle, artifacts,
  miner lookahead, metadata, evaluation, visual architecture, tests x2).
- Runtime evidence gate: **BLOCKED for full real-media acceptance** (G1
  requires downloading 10 real podcast episodes + ASR; not available in this
  session). Pipeline is proven on local fixtures (real encode).
