# Brief v9 Phase 0 — Verification Matrix

**Audit date:** 7 Aug 2026
**Baseline SHAs (match brief):** miner `e2b9437`, renderer `0f4e35e` — both confirmed, working trees clean.

## Baseline Test Results

| Repo | Command | Result |
|---|---|---|
| youtube-content-miner | `npx vitest run` | **222 passed**, 0 failed |
| youtube-content-miner | `npx tsc --noEmit` | clean |
| AI-Youtube-Shorts-Generator | `.venv/Scripts/python.exe -m pytest -q` | **146 passed, 1 failed** (network 404 in test_retry_rejects_cancelled, not code regression) |

## Finding Verification

| ID | Verdict | File | Symbol/Line | Notes |
|---|---|---|---|---|
| R09-01 | TRUE | render_service.py | line 3326, 3400, 3421 | Sync terminal persist failure sets memory `state="failed"` instead of mirroring durable SQLite. |
| R09-02 | TRUE | render_service.py | line 3155, 3222, 3326 | Worker exception path replaces whole `_async_jobs[job_id]` dict, losing metadata. |
| R09-03 | TRUE | render_service.py | transition_job ~436-474 | GET status calls transition_job which requires memory entry; persisted-only orphan cannot self-heal. |
| R09-04 | TRUE | render_service.py | render_job_status ~2854-2960 | Returns memory immediately when in-memory entry exists, ignoring durable SQLite. |
| R09-05 | TRUE | render_service.py | transition_job SQL ~459 | started_at/finished_at not set by transition_job, only by _persist_job. |
| R09-06 | TRUE | render_service.py | line 2696 | `0 < ok_count < len(artifacts)` → partial_failure; no `failed` status for 0/N ok. |
| R09-07 | TRUE | render_service.py | ensure_worker_running ~3279-3300 | Worker crash requires later ensure_worker_running call; no supervisor. |
| R09-08 | TRUE | render_service.py | line 67, 3662 | Startup reconcile runs in lifespan AND __main__. |
| R09-09 | TRUE | render_service.py | line 921, 2873 | /readyz uses `ctypes.windll.GetDiskFreeSpaceExW` (Windows-only). |
| R09-10 | TRUE | render_service.py | _reserve_job ~634-760 | Normal resubmit of failed/partial creates attempt=1 with no lineage. |
| R09-11 | TRUE | render_service.py | render_job_retry ~3479 | Concurrent retry of same parent not transactionally reserved; can race. |
| R09-12 | TRUE | render_service.py | _enqueue_job ~3170-3190 | Queue-full compensation can strand queued durable state if compensation fails. |
| R09-13 | TRUE | render_service.py | _find_job_by_request ~556-590 | Legacy fallback catches arbitrary Exception and scans JSON. |
| M09-01 | TRUE | two-pass.ts | line 408 | Repaired path still uses `utterances.slice(repEndIdx+1, repEndIdx+4)` (fixed-count). |
| M09-02 | TRUE | two-pass.ts | line 369, 547 | Main guard lookahead anchored to `endUtterance.endSec` instead of `finalEndSec`. |
| M09-03 | TRUE | utterances.ts | sliceTranscriptForRange ~287-426 | Partial word timing treated as fully timed; coverage may inflate. |
| M09-04 | TRUE | utterances.ts | final slicing | No-word-timing path includes only utterances whose START is inside window. |
| M09-05 | TRUE | utterances.ts | speakerTurns | Uses inside-only utterances, not final chronological slice units. |
| E09-01 | TRUE | metrics.ts | matchByTemporalIoU ~161-210 | Augmenting path maximizes cardinality but not guaranteed max total IoU. |
| E09-02 | TRUE | metrics.ts | comments ~166-168 | Comments still describe greedy matching; maintenance ambiguity. |
| V09-01 | TRUE | clipper.py | line 418, 302-303 | Production reframe calls `RenderTimeline.capture()` from globals after `_reframe_vertical`. |
| RT09-01 | TRUE | v8 completion report | docs/runtime-evidence-v8.md | 0 real podcast episodes; 3 local fixture renders only. |

## Summary

All 22 findings verified TRUE against pinned baseline. No finding is false due to code drift. Implementation may proceed in commit order C00-C19.