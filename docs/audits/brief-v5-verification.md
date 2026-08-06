# Brief v5 — Phase 0 Verification Report

- Repos: youtube-content-miner (HEAD `c0205b6`), AI-Youtube-Shorts-Generator (HEAD `892f134`)
- Method: every finding verified against actual checked-out code (exact file/symbol/line).
- Status legend: CONFIRMED / ALREADY FIXED / PARTIALLY FIXED / NOT REPRODUCIBLE.

## Renderer lifecycle (R-01..R-07)

### R-01 — CONFIRMED
- `render_service.py:2885-2893` (sync `render`): memory entry `_async_jobs[job_id] = {"state": "queued", ...}` is created for the NEW job_id even when `_reserve_job` returned an idempotency hit (`reserved != job_id`) — phantom queued entry for a job that does not exist in SQLite.
- `render_service.py:2905`: `transition_job(job_id, "queued", "downloading", ...)` return value ignored.
- `render_service.py:2922-2923`: `if sync_error is not None: raise` — bare `raise` OUTSIDE the `except` block (re-raises whatever exception is current in that scope; correct only by accident).
- Risk: phantom memory rows make status API lie; failed CAS can render without advancing state.

### R-02 — CONFIRMED
- Direct `_persist_job(...)` calls bypassing transition legality:
  - `render_service.py:2913` (sync exception → `failed`)
  - `render_service.py:2924` (sync terminal)
  - `render_service.py:2735` (queue worker exception → `failed`)
  - `render_service.py:2770` (`_process_queued_job` terminal)
  - `render_service.py:2603` (orphan status path)
- `_persist_job` accepts any status for any current state; no ALLOWED_TRANSITIONS enforcement.
- Risk: illegal state writes (e.g. completed while rendering) are possible.

### R-03 — CONFIRMED
- `render_service.py:319-351` (`_persist_job`): INSERT column order
  `..., last_error_stage, process_boot_id)` matches VALUES tuple
  `..., PROCESS_BOOT_ID, status if error else None` — i.e. **swapped**.
  `last_error_stage` receives the boot id; `process_boot_id` receives the error stage string.
- `_reserve_job` inserts (force path `:628-629`, normal path `:657-658`) are correct — so only the UPDATE/INSERT path used at terminal/error writes is wrong.
- Risk: persistence round-trip of both fields is corrupted; orphan detection and diagnostics read garbage.

### R-04 — CONFIRMED
- `render_service.py:2693-2697` (`render_async`): reserve durable row → register memory → `_enqueue_job(job_id)`.
- `render_service.py:2708-2709` (`_enqueue_job`): `queue.Full` raises `RuntimeError` — no transition to `failed`, no compensation; the durable `queued` row stays workerless forever.
- Risk: stranded queued job after queue full; upstream poller hangs.

### R-05 — CONFIRMED
- `_persist_job` wraps everything in `except Exception` and returns `None` (no success signal).
- `_process_queued_job` (`:2767-2771`) and sync path (`:2924-2928`) update memory AFTER calling `_persist_job` without checking success — if SQLite commit fails, memory still reports `completed`/`partial_failure`.
- Risk: memory/SQLite divergence on terminal status; health only records `_last_persist_error` passively.

### R-06 — CONFIRMED
- `render_service.py:2156-2160`: `trim_pauses()` replaces `out_path` after pause trimming, changing the media timeline.
- No TimeTransform mapping is emitted; caption timing decision (`:755` `has_word_timing`) still trusts canonical word timings unchanged.
- Risk: captions desync from audio after middle silence removal.

### R-07 — ALREADY FIXED (brief v4 F3)
- `render_service.py:2433`: `transition_job(job_id, "rendering", "quality_check", ...)` runs once AFTER all clips rendered. Per-clip loop no longer mutates job state.
- Keep as a regression-guard test.

## Miner finalization (M-01..M-04)

### M-01 — CONFIRMED
- `two-pass.ts:367-371` slices transcript for `repair.finalStartSec/finalEndSec` BEFORE `finalizeCandidate` is called (`:384`), and `finalizeCandidate` may expand start backward (`finalize-candidate.ts` `expandStartBackToComplete`) — slice text/scoring describes pre-repair content.
- Same issue in semantic path: slice built at `:469` before `finalizeCandidate` at `:480` (which can still reject/expand).
- Risk: final candidate text/score not computed from exact final timestamps.

### M-02 — CONFIRMED
- `two-pass.ts:351-363` (`endingById.set`) builds debug metadata from `startCheck` taken before final start decisions; repaired path stores `startComplete: startCheck.startComplete` not the final value.
- FinalizationResult debug metadata is not the single source; `revision` still means "2=repaired", not a real revision sequence.
- Risk: diagnostics describe pre-final boundaries.

### M-03 — CONFIRMED
- `utterances.ts`: `EnrichedSentence` produced by `cuesToUtterances` never copies `cue.words` into the utterance; `sliceTranscriptForRange` accesses `(u as {words?...}).words` which is always undefined → word-level slicing is claimed but never actually propagates canonical words.
- `timingPrecision='word'` is never produced from real data.
- Risk: "word-level slicing" claim is false; renderer gets cue-level approximations.

### M-04 — CONFIRMED
- `start-boundary.ts:123,143`: `hasLaterReferent` regex includes `he|she|it|they|this|that|these|those|the|dia|mereka|ini|itu|yang` — repeated pronouns themselves count as antecedent ("They ... They ..." resolves). No entity/head-noun check.
- Risk: hard structural failures (unresolved reference) not detected; wrong clips approved.

## Contract parity (C-01) — CONFIRMED
- `contract.ts` (Zod): all `z.object({...})` non-strict — unknown nested fields accepted; `render-request-v2.schema.json` only sets `additionalProperties:false` at 2 levels; `render_contract.py` uses `ConfigDict(extra="forbid")` on 2 models only.
- Clip id normalization to string before duplicate detection not implemented; numeric NaN/Infinity not explicitly rejected in all numeric fields.
- Risk: same payload accepted by TS but rejected by Python; contract drift.

## Timeline / visual (V-01) — CONFIRMED
- `clipper.py:106-120` `RenderTimeline.capture()` reads module globals `_LAST_FACE_TRACKS/_FRAME_TIMELINE/...`.
- No `state_at(time_sec)`, no `crop_rect_normalized`, `safe_caption_zones`, `decision_reason` per sample; caption compositor uses last frame snapshot, not per-cue interval state.
- Risk: captions/camera decisions do not use per-time geometry.

## Golden evaluator (G-01, G-02) — CONFIRMED
- G-01: `metrics.ts:216` — `matchByTemporalIoU(labels, preds, 0.5)` assigns positives and hard negatives in ONE greedy pass; a prediction consumed by a hard-negative cannot also be reported against a positive (brief requires both facts reported independently).
- G-02: `metrics.ts:90-96` — `topKRankAwareRecall` iterates `matches.entries()` (greedy assignment order) as "rank" instead of label expected rank, then assigned prediction rank.

## CI (CI-01) — CONFIRMED
- `.github/workflows/ci.yml` (miner): `npx eslint . --max-warnings 0` has `continue-on-error: true` (lint does not block).
- `.github/workflows/ci.yml` (renderer): `pip install -r requirements.txt 2>/dev/null || pip install ...` — falls back to a reduced dependency set on failure (brief forbids).
- Cross-repo: renderer workflow checks out `titostream27/youtube-content-miner` default branch (unpinned `main`), not a pinned SHA/tag.
- No published test-count artifacts.

## Summary
| Status | Count | IDs |
|---|---|---|
| CONFIRMED (now FIXED in v5 commits) | 15 | R-01..R-06, M-01..M-04, C-01, V-01, G-01, G-02, CI-01 |
| ALREADY FIXED | 1 | R-07 |

## Final status after implementation (brief v5 commits 1-14)

| Finding | Status | Commit |
|---|---|---|
| R-01 sync orchestration | FIXED | 2 (fe85ac1) |
| R-02 state machine only mutation path | FIXED | 2/4 |
| R-03 named persistence + round-trip | FIXED | 2/3 (2a8026d) |
| R-04 queue admission compensation | FIXED | 3 (2a8026d) |
| R-05 terminal durability vs memory | FIXED | 2/3 |
| R-06 caption timing after trim | FIXED | 5 (9f60547) |
| R-07 multi-clip QC | ALREADY FIXED (v4) | — |
| M-01 finalize before slicing | FIXED | 7 (02b9f46) |
| M-02 final debug metadata | FIXED | 7 |
| M-03 word propagation | FIXED | 8 (9f5e922) |
| M-04 entity-only referents | FIXED | 7 |
| C-01 strict cross-language | FIXED | 9 (c9a1082/fd5f324) |
| V-01 ReframeResult + time-indexed | FIXED | 10 (b743d11) |
| G-01 separate positive/negative | FIXED | 12 (8ffe282) |
| G-02 label-rank metrics | FIXED | 12 |
| CI-01 blocking gates + pinned | FIXED | 13 (3164ad0/7939ac7) |

## Test commands (as run in CI)

Miner (content-miner):
- `npm ci`
- `npx tsc --noEmit`
- `npx vitest run`
- `npx eslint . --max-warnings 0`

Renderer (AI-Youtube-Shorts-Generator):
- `pip install -r requirements.txt`
- `python -m pytest test_render_contract.py test_contract_fixtures.py test_job_lifecycle.py test_render_timeline.py test_hardening_sprint.py test_cache_timeline.py test_hardening_v3.py test_hardening_v4.py test_hardening_v5.py test_visual_behavior.py -q`

