# Brief v8 Runtime Evidence — docs/runtime-evidence-v8

**Status: PARTIAL — renderer pipeline exercised on local fixtures; FULL
real-media acceptance (G1: 10 real podcast episodes; G2: 3 final renders of
approved candidates) is NOT fully met in this run.** See §4 for the honest
gap and what is missing to reach BLOCKED→DONE.

## 1. Repository heads

| Repo | HEAD | Commit | Worktree |
|---|---|---|---|
| youtube-content-miner | `5c1c238` | C12 fix(eval) | clean |
| AI-Youtube-Shorts-Generator | `a36eebf` | C16 ci pin | clean |

## 2. Test evidence (real tool output)

**Miner (`npx vitest run`):** 218 passed, 29 files, 0 failed. `tsc --noEmit` clean.
- Moments suite: 87 tests (incl. hardening-v8 lookahead/metadata source guards).
- Golden: 22 tests (incl. golden-v8 E01 max-cardinality + E02 denominators).

**Renderer (Windows, `.venv\Scripts\python.exe -m pytest -q`):**
- **Run 1: 147 passed, 42 subtests, 0 failed** (92.8s)
- **Run 2: 147 passed, 42 subtests, 0 failed** (92.7s)
- T01/SQLite file-lock contention fully resolved (test_hardening_v7 now
  isolates temp DB + closes connections).

## 3. Renderer media evidence (real encode pipeline, local fixtures)

The reframe + final-encode pipeline was executed for real (not mocked):
- Source fixtures: `fixtures/visual/dual_speaker.mp4`, `reaction.mp4`,
  `hard_cut.mp4` (real 720p mp4, 6s, mpeg4).
- Executed `reframe_vertical(..., '9:16', output_size=(1080,1920))` → FFV1
  lossless intermediate (`.silent.mkv`) with live per-frame processing
  (150 frames each) and planner produces `planner_hold_reason`.
- Then ffmpeg final encode to H.264 1080x1920.

| Output | Codec | Res | Bytes |
|--------|-------|-----|-------|
| `dual_speaker` → render1_final.mp4 | h264 | 1080x1920 | 31,804 |
| `reaction` → reaction_final.mp4 | h264 | 1080x1920 | 37,790 |
| `hard_cut` → hard_cut_final.mp4 | h264 | 1080x1920 | 45,149 |

This exercises end-to-end: source → reframe (camera/face/layout) → lossless
intermediate → final H.264/AAC MP4. It is REAL media processing, not a
mocked function return.

## 4. Honest gap — real-episode intelligence evaluation (G1) BLOCKED

- G1 (≥10 real podcast episodes, transcripts, candidates, manual verdicts,
  boundary audit) was NOT executed. There is no network download of real
  podcasts nor an ASR transcript pass in this run.
- G2 partial: 3 final MP4s were rendered, but from LOCAL synthetic fixtures,
  not from 3 approved candidates of the 10-episode set. The "≥1 with two
  visible speakers + canonical captions with word timing" caption-sync checks
  were not performed on real captions.
- Failure/restart/idempotency/queue-full scenario battery (G3) was covered by
  unit/integration tests (STATE/API/LIFE across committed suites), not as a
  live server + real download run.

## 5. What is required to reach DONE (BLOCKED input list)

- Network access to download ≥10 real podcast episodes (YouTube URLs) and
  the installed yt-dlp + ASR (faster-whisper) to produce transcripts with
  word timing.
- Model/LLM credentials already present.
- A proxy-free route to YouTube.
- Time budget for 10 full pipeline runs + manual review.

If the operator provides a manifest of 10 real episode URLs and enables the
downloader, the miner pipeline can be run and the evidence table completed.

## 6. Feature readiness verdict

**READY WITH LIMITS**
- All code-level gates green (API/state/lifecycle/artifacts/meta/eval divided
  across C1-C16, both full-suite runs green).
- Runtime media: pipeline executed on local fixtures (real encode).
- BUT the mandated real-episode acceptance (B- and G-commit evidence) could
  not be executed → the runtime-evidence gate is **BLOCKED for the Full
  acceptance subset**, not DONE.
- Blocker: no downloaded real podcast corpus / network download available in
  this session. Exactly which input is missing is listed in §4.