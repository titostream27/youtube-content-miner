# V12R G3 Evidence — Automated Technical + Visual QC

**Date:** 2026-08-08
**Brief section:** Phase O/P/Q (§18-20)
**Artifacts:** `evidence/v12r/g3/<clip_id>/` (render_request.json, job_status.json, ffprobe.txt, qc.json, visual_judge.json, frames/)

## 1. Rendered clips

Three silver-gold **PASS** candidates were rendered through the production
render service (port 8084, 9:16, real captions from the frozen transcript,
production semantic timestamps):

| clip | episode | window | source of PASS | type |
|---|---|---|---|---|
| `c=9a9beca1058c` | 2HLGcRpw1hc (Jagger) | 2442.56–2481.84 (39.3 s) | benchmark consensus (C_2OF3_PASS) | single-focus |
| `c=c410ad997f6c` | 376JmatmnaI (Millie) | 0.62–60.62 s (clamped to 60 s hard max) | benchmark consensus (AB_PASS) | single-focus |
| `c=7d4430531900.h1` | 2HLGcRpw1hc (Jagger) | 2067.92–2116.40 s (48.48 s) | H1 counterfactual repair → re-judged PASS | single-focus (expanded) |

Disclosure: none of the three is "production-selected" in the strict sense —
the only V12 production-accepted candidate (Iqbal) was silver-FAIL, and the
corpus transcripts carry **no speaker diarization**, so the brief's ≥2
"genuine multi-speaker" requirement cannot be demonstrated from this data.
The G3 render pipeline itself is proven operational and auditable.

## 2. Technical QC (automated ffprobe + ffmpeg detectors)

| clip | codec | resolution | pix fmt | duration | audio | black | frozen | captions |
|---|---|---|---|---|---|---|---|---|
| c=9a9beca1058c | h264 | 1080x1920 | yuv420p | 39.25 s | aac 2ch 96k | 0 | 0 | 7 lines |
| c=c410ad997f6c | h264 | 1080x1920 | yuv420p | 59.98 s | aac 2ch 96k | 0 | 0 | 4 lines |
| c=7d4430531900.h1 | h264 | 1080x1920 | yuv420p | 48.42 s | aac 2ch 96k | 0 | 0 | ✓ |

Technical QC: **PASS for all 3** (h264/yuv420p/positive duration/0 black/0 frozen/captions present). Frames sampled (4 per clip) into `frames/`.

## 3. Visual judge (sampled-frames proxy, cx/gpt-5.6-luna vision)

| clip | face_framing | speaker_align | switch proxy | ping-pong | caption-collision | head-cutoff | layout |
|---|---|---|---|---|---|---|---|
| c=9a9beca1058c | PASS | PASS | PASS | LOW | NONE | NONE | PASS |
| c=c410ad997f6c | PASS | PASS | PASS | LOW | NONE | NONE | PASS |
| c=7d4430531900.h1 | PASS | REVIEW | REVIEW | LOW | NONE | NONE | PASS |

No FAIL anywhere. Notes per judge: switch-smoothness is explicitly labeled a
**still-frame proxy**, never full-motion smoothness (brief §18.2).

## 4. Phase P final aggregation

- SEMANTIC QC (silver consensus): PASS for the 3 rendered clips
- TECHNICAL QC: PASS (3/3)
- VISUAL QC: no FAIL (2 all-PASS, 1 PASS-with-REVIEW-proxy)
- CAPTION/AUDIO: no FAIL (real captions, aac stereo, no collision/cutoff)

**FINAL PASS (development acceptance): 3/3 clips qualify**, with the caveat
that REVIEW does not count toward G3 clips requiring multi-speaker material —
all three are single-focus; multi-speaker validation remains BLOCKED by the
absence of diarization in the frozen corpus.

## 13. Renderer protection gate (Phase Q)

- Renderer worktree pytest: 204 passed + 44 subtests when visual fixtures are
  present; the only flaky failure (idempotent-hit integration test) passed
  when run in isolation and coincided with the render service being busy with
  V12R jobs — no production renderer code changed in V12R.
- Renderer GitHub Actions: already green at 5d91cbe (V11 recovery); no V12R
  commit touches the renderer repository.