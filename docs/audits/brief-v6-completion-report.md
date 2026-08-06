# Brief v6 Completion Report

## Baseline
- Miner starting SHA: `64c251b`
- Renderer starting SHA: `fd97342`
- Miner ending SHA: `cd96695`
- Renderer ending SHA: `9d2f9c0`

## Verification audit
- Confirmed findings: 12 (R01, R02, R03, R05, R06, R07, M01, M02, M03, C02, C03, E03)
- Partially fixed findings: 2 (R04 → Option A fully implemented; C01 → parity fixtures + checks added)
- Already-fixed findings: 2 (E01, E02 from v5 commit 12)
- Not reproducible findings: 0
- Scope changes approved/required: none — stop condition (>3 NOT REPRODUCIBLE) NOT triggered.

## Changes by phase
### Renderer state correctness (commits 1-5)
- require_transition() checked helper for every active/terminal transition;
  lost CAS raises JobTransitionConflict and stops work (R01).
- Sync terminal persistence return checked; False raises and never yields a
  success response or memory completed (R03).
- Worker exception handler only overwrites memory=failed when the transition
  wins; a winning terminal (cancelled) is preserved (R02).
- quality_check is a checked job-level stage after all clips render;
  ensure_worker_running() restarts a dead worker exactly once; worker loop
  resets the started flag on exit (R04/R05).
- Production crop/caption paths REQUIRE an explicit RenderTimeline;
  RenderTimelineMissingError on bare path; no module-global stats fallback
  (R06).
### Miner finalization and slicing (commits 6-8)
- finalizeCandidate fully revalidates the FINAL range after start repair
  (duration, ending, contamination, topic boundary) before slicing (M01).
- sliceTranscriptForRange computes wordTimingCoverage and uses honest
  precision: word / hybrid / utterance; untimed overlapping speech is always
  retained in hybrid mode (M02). No-word fallback labeled 'utterance' not
  'cue' (M03).
### Contract parity (commits 9-10)
- 6 new invalid fixtures (C-INV-01/02/04/06/08/09) in the shared manifest.
- Pydantic narrative checks read clip.narrative (finite, in-clip, hook<=payoff);
  cue and editing-event chronological order enforced (C02).
- Zod language default 'auto', narrative in-clip checks (C01/C02).
- RenderResponse strictly typed with RenderArtifactResult; QCDetail.status;
  no List[Dict] in response model (C03).
### Visual planner behavior (commit 11)
- CameraPlanner pure state machine over detections/audio/scene events;
  VIS-01..08 decision tests (single speaker, no size steal, handoff, miss
  hold, scene reset, split field, false face, audio hysteresis).
### Golden evaluator (commit 12)
- boundaryError/contaminationError/binaryAccuracy deprecated and redirected
  to the canonical AssignmentResult (temporal IoU), no clipId equality (E03).
### CI and documentation (commits 13-14)
- Renderer CI pins miner at cd96695; hardening-v6 in blocking set; miner CI
  already blocking from v5.

## Tests
- Exact commands:
  - Miner: `npm ci`; `npx tsc --noEmit`; `npx vitest run`; `npx eslint . --max-warnings 0`
  - Renderer: `.venv/Scripts/python.exe -m pytest test_render_contract.py test_contract_fixtures.py test_job_lifecycle.py test_render_timeline.py test_hardening_sprint.py test_cache_timeline.py test_hardening_v3.py test_hardening_v4.py test_hardening_v5.py test_hardening_v6.py test_visual_behavior.py -q`
- Pass/fail counts:
  - Miner: 210 passed (27 files), tsc 0 errors
  - Renderer: 114 passed + 26 subtests
- Skipped tests and reason: none in the v6 correctness suites.
- E2E scenarios completed: mocked render E2E across lifecycle tests
  (transition conflict, cancel, worker restart, persistence failure,
  timeline missing, two-clip stage observation). Real-media E2E (Section 11)
  NOT completed — requires 10 real podcast episodes + 3 rendered approved
  clips (see Known remaining risks).

## Compatibility
- V1 request behavior: unchanged (legacy adapter still accepted, upgraded
  internally).
- V2 request behavior: stricter — narrative in-clip/order, cue/event order,
  language default 'auto' (was required/en). All v2 valid fixtures still
  pass.
- Response changes: RenderResponse.rendered/artifacts are now typed
  RenderArtifactResult objects with clip_id str + publishable + qc_status;
  `clip_url` renamed `video_url` in the typed result (was only in legacy
  dicts). Consumers of the JSON still see the same field names after
  model_dump.
- Database migration: none — schema untouched, existing render_jobs rows
  remain readable (v6 12.4).

## Known remaining risks
- Real-media E2E gate (Section 11.1): 10 real podcast episodes + 3 rendered
  approved clips NOT executed — requires real transcript data and manual
  review; automated tests pass but runtime evidence on real content is the
  remaining readiness gap.
- Worker restart uses is_alive() (OS thread) — a thread that is alive but
  wedged inside a blocking FFmpeg call is not detected; acceptable for the
  current single-worker architecture (no FFmpeg process cancellation is a
  v6 non-goal).
- QC artifact-level semantics: Option A (job-level phases) chosen; artifact
  publishable gating still derives from per-clip QC results inside _render.

## Rollback instructions
- Each commit is independently revertible (git revert <sha>):
  - Commit 2 (8ac9883) reverted alone restores unchecked transitions; reverts
    cleanly.
  - Commit 10 (4149df1) response typing: reverting REQUIRES also reverting
    the renderer test updates (test_hardening_sprint, test_hardening_v4) or
    the suite fails — contract-version-affecting change.
  - Commit 13 (9d2f9c0) CI pin: safe to revert; CI then uses previous pin.
- Contract changes are cross-repo: if 4149df1 (Pydantic) is reverted,
  keep e4f2b06 (Zod) or add a compatible adapter — both sides must stay in
  lockstep (15.1).
- No render artifacts or database history are deleted during rollback.

## Feature-readiness recommendation
- **READY WITH LIMITS**
- Evidence supporting the decision:
  - All 14 v6 commits landed; 12 confirmed findings fixed, 2 already fixed,
    2 partially-fixed closed; 210 miner + 114 renderer tests green; tsc 0.
  - CI blocking and pinned; typed response; no stale global fallback;
    planner behavior tested from detections.
  - Limits: the Section 11.1 real-podcast review sample (10 episodes / 3
    rendered) is NOT yet executed — that is the remaining evidence for
    publishable-quality claims, and auto-upload/learned ranking remain
    blocked per v6 2.3 until that dataset exists.
