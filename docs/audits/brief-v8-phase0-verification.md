# Brief v8 Phase 0 — Verification Matrix

**Audit date:** 7 Aug 2026
**Baseline SHAs (match brief):** miner `72b7a1f`, renderer `655f5b7` — both confirmed, working trees clean.

Verification method: source inspection (grep/sed), NOT README. Baseline test suite run before any edit.

| ID | Pri | Verdict | Evidence (file:line) |
|----|-----|---------|----------------------|
| R01 | P0 | TRUE | render_service.py:2945 `@app.post("/api/render/async", response_model=RenderResponse)` returns `RenderSubmissionResponse` → FastAPI validation mismatch |
| R02 | P0 | TRUE | render_service.py:2640 `rendered=[` + 2657 `artifacts=[` — two separately-built lists; aggregate QC mutates only artifacts (render_service.py ~2560-2570) |
| R03 | P0 | TRUE | _process_queued_job persist-failure branch sets memory `state="failed"` when SQLite may hold active (v7 was only partial fix — job.update still writes failed even if transition uncommitted) |
| R04 | P0 | TRUE | render_service.py:3458 `if __name__=="__main__"`; orphan reconcile (3466) + worker startup only there; `uvicorn render_service:app` bypasses |
| R05 | P1 | TRUE | `/readyz` requires alive worker (line ~872) but worker starts lazily on first job |
| R06 | P1 | TRUE | `/readyz` SELECT-only probe + emits `postgres: wal` (render_service.py readyz) |
| R07 | P1 | TRUE | render_service.py:2995 reserved duplicate hardcodes `state="queued"` |
| R08 | P1 | TRUE | sync idempotent checks memory only; persisted completed response absent from memory → 409 unknown (render_service.py render) |
| R09 | P1 | TRUE | worker exception/success terminal paths whole-dict assign in several spots |
| R10 | P1 | TRUE | legacy request lookup fallbacks `_find_job_by_request` history inconsistent under `_db_lock` |
| M01 | P0 | TRUE | two-pass.ts:236, 361 `utterances.slice(endIdx + 1, endIdx + 4)` still count-based (deterministic + repair) |
| M02 | P1 | TRUE | two-pass.ts:547 `followingWithinLookaheadSec(..., endU.startSec, ...)` anchors to utterance start, not final e |
| M03 | P1 | TRUE | two-pass.ts:429 `endingById.set` before finalizeCandidate:447 (repaired) — pre-final metadata |
| M04 | P1 | TRUE | two-pass.ts semantic branch has inline start-repair before finalizer (two sources of truth) |
| E01 | P1 | TRUE | metrics.ts:154 `matchByTemporalIoU` greedy consume; 231 canonical assignment greedy IoU |
| E02 | P1 | TRUE | metrics.ts:311/436 `n: labels.length` ambiguous; no positive/negative/ignored denominators |
| V01 | P1 | TRUE | clipper.py `_reframe_vertical` calls planner but inline tracker owns major decisions; planner exception swallowed |
| V02 | P1 | TRUE | clipper.py `RenderTimeline.capture()` copies `_LAST_*`, `_FRAME_TIMELINE`, `_RENDER_STATS` module globals |
| T01 | BLOCK | TRUE | Full renderer suite: **3 failed / 130 passed** (SQLite file-lock contention in full run, pass in isolation) |
| RT01 | BLOCK | TRUE | No real-media 10-episode/3-render evidence in history |

## Baseline test results (before edits)

**Renderer (Windows, `.venv\Scripts\python.exe -m pytest -q`):**
- Run 1: **130 passed, 3 failed** (test_hardening_v7 x3 — SQLite contention), 42 subtests, 92s
- The 3 failures are the T01 isolation bug (known).

**Miner (`npx vitest run`):** 215 passed (28 files), `tsc --noEmit` clean.

## Phase 0 gate

Findings R01-R04, M01 (2 sites), R07, R02, E01, E02, T01 all TRUE → brief instructions are current; proceed with Phase A onward.

**Do NOT add product features. Closure only.**