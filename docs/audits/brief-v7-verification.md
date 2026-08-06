# Brief v7 Verification Report

**Baseline**: miner `a3f388c`, renderer `5adf72f`
**Date**: 6 August 2026

## Renderer Findings

| ID | Status | File/Symbol | Line Range | Summary |
|---|---|---|---|---|
| V7-R01 | **CONFIRMED** | render_service.py `render_async`, render_contract.py `RenderResponse` | service:~2500, contract:~350 | Async endpoint returns `RenderResponse` with `status: Literal["completed","partial_failure"]` defaulting `"completed"`. Cannot represent `queued`/`active`. Idempotent hit returns same model. |
| V7-R02 | **CONFIRMED** | render_service.py `_render`, render_contract.py `RenderResponse` | service:~2580, contract:~350 | `_render` constructs `RenderResponse(job_id=..., source_video=..., rendered=...)` without passing `status=final_status`. The `status` field defaults to `"completed"`, so a partial-failure job's embedded response says completed. |
| V7-R03 | **CONFIRMED** | render_service.py `_process_queued_job` | ~2450-2480 | On persistence failure/CAS loss, the exception handler sets `job["state"] = "failed"` in memory even when SQLite may still hold `quality_check` or `rendering`. Memory and durable state diverge. |
| V7-R04 | **CONFIRMED** | render_service.py `_queue_worker_loop` | ~2400-2430 | Exception handler replaces entire job dict: `_async_jobs[job_id] = {"state": "failed", "error": str(e)}` — loses request_id, mode, episode_id, parent_job_id, attempt, timestamps. |
| V7-R05 | **CONFIRMED** | render_service.py `_render` | ~2100-2300 | QC (`quality_gate`) runs per-clip inside the rendering loop. After all clips, `require_transition("rendering", "quality_check")` fires then immediately transitions to terminal. quality_check state holds no actual work. |
| V7-R06 | **CONFIRMED** | render_contract.py `RenderArtifactResult` | ~340-370 | No model_validator prevents `publishable=True` with `qc_status="failed"/"unavailable"` or `mode="preview"`. `rendered` and `artifacts` are built from separate mapping logic in `_render`. |
| V7-R07 | **CONFIRMED** | render_service.py `_persist_terminal_via_transition` | ~1900-1950 | Auto-advance loop: walks `queued→downloading→analysing→rendering→quality_check→completed/partial_failure`. Production path can jump from any earlier state to terminal in one call. |
| V7-R08 | **CONFIRMED** | render_service.py `_enqueue_job` | ~2350-2380 | On queue-full, returns HTTP 503 but does not commit a `queued→failed` transition. The SQLite row remains `queued` with no queue item — stranded row. |
| V7-R09 | **CONFIRMED** | render_service.py `render_job_retry` | ~2650-2700 | Creates memory+SQLite rows directly (INSERT + dict assignment), bypassing `_reserve_job` atomicity. No BEGIN IMMEDIATE, no uniqueness conflict handling for concurrent retries. |
| V7-R10 | **CONFIRMED** | render_service.py health endpoints | ~2700-2750 | GET `/health` always returns `{"status": "ok"}`. `/api/render/health` is readiness-like but always reports `status: ok` header. `_job_older_than` documents "unparseable = old" but returns `False`. No liveness vs readiness separation. |
| V7-Q01 | **CONFIRMED** | render_service.py `_render` | ~2100-2300 | QC runs inside rendering loop (per-clip). quality_check transition is administrative: transition fires, then immediately moves to terminal. During quality_check state, no work is happening. |

## Miner Findings

| ID | Status | File/Symbol | Line Range | Summary |
|---|---|---|---|---|
| V7-M01 | **CONFIRMED** | two-pass.ts `finalRangeValidationFor` | ~320-350 | Uses `utterances.slice(endIdx + 1, endIdx + 1 + nextTopicLookaheadSec)` where `nextTopicLookaheadSec` (typically 8) is a seconds value used as an utterance count. At fast speech (many short utterances), this examines too few seconds; at slow speech, too many. |
| V7-M02 | **CONFIRMED** | two-pass.ts repaired/semantic paths | ~400-450 | `endingById[id]` metadata is set BEFORE `finalizeCandidate()` call. If finalizeCandidate alters start (repair), the stored metadata reflects pre-final range, not actual final range. |
| V7-M03 | **CONFIRMED** | utterances.ts `sliceTranscriptForRange` | ~310-340 | Coverage = `mergedTimed / windowDuration` where `mergedTimed` = union of word durations and `windowDuration` = `endSec - startSec`. Inter-word gaps and natural pauses inflate the denominator, making fully word-timed clips mislabeled `hybrid` at the 0.95 threshold. |
| V7-M04 | **CONFIRMED** | utterances.ts `sliceTranscriptForRange` | ~345-365 | Hybrid text = `${wordLevelText} ${untimedText}` — all timed words concatenated first, then all untimed text appended. Not chronological. If order is A(timed) → B(untimed) → C(timed), output is "A C B" not "A B C". |

## Visual Findings

| ID | Status | File/Symbol | Line Range | Summary |
|---|---|---|---|---|
| V7-V01 | **CONFIRMED** | clipper.py `CameraPlanner` vs `_reframe_vertical` | planner:~100-270, reframe:~600+ | CameraPlanner class exists with `.step()` but production `_reframe_vertical` does NOT call `CameraPlanner.step()`. Production uses its own tracking/crop logic (YuNet/Haar face detection → centroid smoothing → crop rect). VIS-01..08 tests cover an isolated planner that is never used in production. |
| V7-V02 | **CONFIRMED** | clipper.py `RenderTimeline.capture()` | ~270-310 | `capture()` is a classmethod that reads module-level globals (`_last_frame_entries`, `_last_stats`, etc.) to build a timeline. `reframe_vertical` calls `_reframe_vertical` then `RenderTimeline.capture()` post-hoc — not built locally inside the reframe call. |

## Evaluator Findings

| ID | Status | File/Symbol | Line Range | Summary |
|---|---|---|---|---|
| V7-E01 | **CONFIRMED** | metrics.ts `evaluateGolden` | ~380-410 | `hardNegativeFPR = overlapCount / negativeLabels.length`. If 3 predictions overlap 1 negative label, result is 3.0 — exceeds 1.0, misleading as a "rate". |
| V7-E02 | **CONFIRMED** | brief-v6-completion-report.md | "Known remaining risks" section | Explicitly states: "Real-media E2E gate (Section 11.1): 10 real podcast episodes + 3 rendered approved clips NOT executed". |

## Summary

- **CONFIRMED**: 18/18 (R01-R10, Q01, M01-M04, V01-V02, E01-E02)
- **PARTIALLY CONFIRMED**: 0
- **ALREADY FIXED**: 0
- **NOT REPRODUCIBLE**: 0
- **Stop condition (>3 P0 NOT REPRODUCIBLE)**: NOT triggered.

## Finding Priority Distribution

- **P0**: R01, R02, R03, R05, R06, Q01, M01, M03, M04, V01 (10 findings)
- **P1**: R04, R07, R08, R09, R10, M02, V02, E01, E02 (9 findings)

All 18 findings confirmed against the verified baseline SHAs.

## STOP — Awaiting approval before implementation.
