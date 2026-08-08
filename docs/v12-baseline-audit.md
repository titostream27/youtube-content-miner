# Brief V12 Baseline Audit

**Date:** 2026-08-08
**Brief source:** `Brief_V12_Candidate_Quality_Self_Contained_Moment_Selection.pdf`
**Preamble:** no assumptions — every number below comes from a live read of the repos and the frozen transcript DB.

## 1. Repository state

| Repo | Branch | HEAD | Git status | PR | Latest GitHub Actions |
|---|---|---|---|---|---|
| youtube-content-miner | `fix/brief-v12-candidate-quality` | `0b6f532eaf29f8d53b6726fa48c6406e518794d9` | clean | open: PR #5 (`fix/brief-v11-boundary-recovery` -> main) | `0b6f532`: completed/success |
| AI-Youtube-Shorts-Generator | `fix/brief-v11-renderer-recovery` | `5d91cbe8887ea2d10cea8af5b8a4b9566dc924fd` | clean | open: PR #1 | `5d91cbe`: completed/success |

Known state before this brief (from V11 reports, verified by the audit above): CI green, G1 10/10 usable, boundary negative-duration defect fixed, G2/G3 still blocked.

## 2. Pipeline configuration actually in effect

From `D:/homelab/hermes-workspace/content-miner/.env` (production host source of truth) - no assumptions:

| Setting | Value |
|---|---|
| AI_PROVIDER | `deepseek` |
| MAX_SCORED_SEGMENTS_PER_EPISODE | 40 |
| CLIP_SCORE_THRESHOLD | 70 |
| SEGMENT_MIN_SEC | 15 |
| SEGMENT_MAX_SEC | 90 |
| SEGMENT_TARGET_SEC | 45 |
| CLIP_HARD_MAX_SEC | 90 |
| HIGHLIGHT_MIN_ENDING_CONFIDENCE | 0.82 (default; not overridden in .env) |
| HIGHLIGHT_MIN_COMPLETE_DURATION_S | 14 (default) |
| HIGHLIGHT_NEXT_TOPIC_LOOKAHEAD_S | 12 (default) |
| HIGHLIGHT_END_GUARD_S | 0.2 (default) |
| HIGHLIGHT_MAX_NEXT_TOPIC_CONTAMINATION | 0.18 (default) |
| SEGMENT default minSalience | 0.3 (code default) |

Note: the production `.env` points `DEEPSEEK_BASE_URL` at `host.docker.internal`, which is a
container-only alias. On a host run this makes the LLM path fail and the pipeline falls back to
the heuristic engine. V11 evaluations observed engine="heuristic" with fallback_used=false; that
is consistent with the provider failing before logging (recorded, not guessed, in
`docs/v12-candidate-quality-analysis.md`).

## 3. Frozen G1 corpus (untouched; hashes computed from the cached transcript DB)

Source DB: `content-miner/data/content-miner.db` (read-only); transcript provider `youtube_asr` for all 10.

| episode_id | title | language | source | transcript_provider | cues | duration_sec | transcript_hash (sha256, first 20) | usable |
|---|---|---|---|---|---|---|---|---|
| I6wCuvvaRPI | KIM KARDASHIAN (Full Episode) | en | youtube_asr | youtube_asr | 2784 | 6204 | 5eb01a148cbd41071b74 | yes |
| GOqEl4ADyVk | TOM HOLLAND interview | en | youtube_asr | youtube_asr | 3672 | 6653 | 000ef5793edf5d42a450 | yes |
| 2HLGcRpw1hc | Mick Jagger (Conan) | en | youtube_asr | youtube_asr | 1829 | 3976 | 3c1f3fec22d9805c6a6d | yes |
| UZ1kCEGjYX0 | Matt Damon (Conan) | en | youtube_asr | youtube_asr | 1851 | 3693 | fc16e5c142187c9ef069 | yes |
| Hb2rKGfIOrM | Obama x Maron | en | youtube_asr | youtube_asr | 1753 | 4080 | 6967ea52713d1d61154 | yes |
| g2cQ2kD6lzs | KOBE x Jay Shetty | en | youtube_asr | youtube_asr | 1553 | 2586 | 51698356e8f52223ec57 | yes |
| Ive926sC6mc | Sisi Lain Iqbaal Ramadhan | en | youtube_asr | youtube_asr | 2236 | 3925 | 26cd94670f68c49e88a4 | yes |
| 3NSC5nps3OM | Cerita Cinta Idgitaf | en | youtube_asr | youtube_asr | 2059 | 3807 | 2cd411a2eb1d4aec5564 | yes |
| 376JmatmnaI | Millie Bobby Brown | en | youtube_asr | youtube_asr | 1834 | 4059 | a92b6a711afa7f117473 | yes |
| XuoqKYxDHVc | Elon Musk interview | en | youtube_asr | youtube_asr | 2702 | 5103 | e0cfa98274f029b98703 | yes |

Timing precision: all 10 transcripts are cue-level (no word-level timing); timing coverage = 0.

## 3. Known baseline numbers (V11 final)

- Previous G2 yield: 10 episodes evaluated, 1 accepted clip (Iqbal `Ive926sC6mc` 2097.48-2138.04, score 80) — per `docs/evidence/brief-v11-g2-production-summary.jsonl`.
- V11 protected fixes: negative duration impossible, start collapse fixed, filtered/full index confusion fixed, ending search window-local.
- V12 must not weaken CI, must not lower thresholds (0.82 / 70), must not fabricate human listening corpus.

## 4. Hypothesis slate (brief §2.1)

H1..H10 as written in the brief. This audit does NOT commit to any hypothesis; the lineage
instrumentation in Phase B produces the observations that separate them.