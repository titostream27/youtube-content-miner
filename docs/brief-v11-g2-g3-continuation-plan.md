# Brief V11 G2/G3 Continuation Plan (manual review phase)

**Date:** 2026-08-08
**Status:** G2/G3 remain BLOCKED pending human review. Everything below is actionable without touching pipeline thresholds or injecting manual timestamps.

## Current evidence inventory

| Artifact | Where | Status |
|---|---|---|
| G1 corpus manifest | `docs/evidence/brief-v11-g1-corpus.json` | PASS 10/10 |
| G2 production summary | `docs/evidence/brief-v11-g2-production-summary.jsonl` | 10/10 evaluated, 1 accepted, 0 negative durations |
| Candidate shortlist + watch links | `docs/evidence/brief-v11-manual-annotation-worksheet.md` | ready |
| Annotation slots | `docs/evidence/brief-v11-manual-annotation-worklist.json` | 0/10 publishable, 0/10 hard-negative |
| G3 artifacts | `docs/evidence/brief-v11-g3-artifact-manifest.json` | 1 qualified historical (Iqbal), BLOCKED |

## Steps

### 1. Manual review (human, per episode)
- Open worksheet, click each `watch` link (YouTube opens at the candidate start).
- Fill in the worklist JSON:
  - `publishable.status` = `PASS` (with start_sec/end_sec/hook/topic/payoff/self_contained_reason/ending_complete) or `FAIL` (reason)
  - `hard_negative.status` = `PASS` (it IS publishable as a short, so no hard-negative) or `FAIL` (reason) — the brief requires *10 publishable and 10 hard-negative* rows; use "hard-negative" as a dual check: if the episode should have clips but none work, record FAIL with reason.
- Expected effort: 10 episodes x ~10 minutes of listening.

### 2 — Top-1/Top-3 comparison
- For each episode with ≥1 manual PASS, compare manual rank order against pipeline output (accepted clips come from `brief-v11-g2-production-summary.jsonl`, `top1`/`top2`/`top3`).
- Record in the worklist: agreement, disagreement type (miss, false-positive, off-by-window).

### 3 — Re-run production after human evidence (only if justified)
- If manual review shows systematic rejection mismatches on ≥3 episodes, email/listening evidence exists. Only then is a classifier tuning pass justified as a separate change, not a silent follow-up patch.
- Re-run `scripts/real-media-prod-eval.ts` with the production provider after any tuning.

### 4 — G3 full playback reviews
- Produce/keep 3 production-selected outputs (pipeline-selected, not hand-inserted).
  - 1 available now: `rendered/62c3238f36/short_01.mp4` (Iqbal, video_id `Ive926sC6mc`, 40.5s, H.264 1080x1920 yuv420p + AAC).
  - 2 additional outputs CANNOT be fabricated: two genuine speaker-switch selections must come from the production pipeline accepting 2 more clips (tasklist: monitor on reruns).
- For each output, complete the checklist (human):
  - [ ] hook visible/audible, [ ] topic boundary lands, [ ] payoff lands, [ ] self-contained, [ ] ending complete, [ ] audio/video sync, [ ] no black frames, [ ] 9:16 and H.264 AAC for YouTube Shorts.
- Record checks in a `brief-v11-g3-full-playback-checklist.json` (one entry per output; status PASS/FAIL/N-A).

### 5 — Refresh evidence files
- Worksheet: `DATABASE_PATH=... npx tsx scripts/brief-v11-annotation-candidates.ts`
- G2: `DATABASE_PATH=... npx tsx scripts/real-media-prod-eval.ts`, outputs under `docs/evidence/`.

## Explicitly not done (to keep evidence truthful)
- No lowering of the 0.82 ending-confidence threshold.
- No injection of manual timestamps into production selection or renderer.
- No synthetic/fixture clips counted as G3.
- No skip of the visual regression suite in CI.

## Definition of done
- Worklist JSON: 10 publishable slots + 10 hard-negative slots all filled with `status: PASS`/`FAIL` + reasons.
- Top-1/Top-3 comparison available for ≥3 episodes with ≥1 accepted pipeline clip.
- 3 production-selected MP4 outputs exist (1 ready; 2 awaiting pipeline switch selections or classifier tune with evidence).
- 3 full-playback checklists completed with PASS flags.
- Then: gate verdict for G2/G3 re-evaluated (likely PASS if criteria met) and final CI rerun on the exact final SHA.