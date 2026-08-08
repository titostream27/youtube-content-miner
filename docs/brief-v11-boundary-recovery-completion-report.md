# Brief V11 Boundary Recovery — Completion Report

**Date:** 2026-08-08
**Scope:** correctness recovery and truthful acceptance recovery; not V12 and not a feature sprint.
**Final verdict:** **BLOCKED**

## Evidence verdict table

| Gate | Evidence | Verdict |
|---|---|---|
| Boundary correctness | BR-01..BR-12, generated invariants, semantic invalid-range regression; post-fix real-media negative duration count = 0 | **PASS** |
| Miner local CI | `npm ci`; TypeScript 0; Vitest 266 passed; ESLint 0 errors / 0 warnings | **PASS** |
| Miner GitHub Actions | Run `31252910568` on `5d7be6f…` (exact recovery SHA): success | **PASS** |
| G1 | `docs/evidence/brief-v11-g1-corpus.json`: 10 unique usable real episodes, 10 non-empty transcripts | **PASS (10/10)** |
| G2 production evaluation | `docs/evidence/brief-v11-g2-production-summary.jsonl`: all 10 evaluated; 1 accepted clip; 0 negative durations | **BLOCKED** |
| G2 manual corpus | Worklist exists, but 0/10 publishable and 0/10 hard-negative annotations have human playback review | **BLOCKED** |
| Renderer local CI | 205 passed + 44 subtests; required visual suite executed: 4 passed + 16 subtests, 0 skip | **PASS** |
| Renderer GitHub Actions | Run `31253140819` on `f3e7f7d…` (exact recovery SHA): success | **PASS** |
| G3 | Only Iqbal matches current post-fix production selection; no two genuine speaker-switch selections; no 3/3 full playback reviews | **BLOCKED** |
| Documentation consistency | This report and correction records supersede contradictory acceptance claims | **PASS** |

## 1. Repository SHAs

- Miner audited baseline: `35de09822132b8f0f4a0fb58633426fd0d202a97`.
- Miner recovery final SHA: `5d7be6f93904b9a40156fb912ef0bda990700bdb`.
- Renderer recovery final SHA: `f3e7f7d70fdbe15f09cc77bd33b67f1a520af605`.
- Renderer local recovery base: `a93e7813146bf2016812d0c91083681d66b5e589`.
- Renderer pushed fork `main` at audit: `1a04a5e155a643ac415336dfce4be1d544e0570d`.
- Renderer upstream `main` at audit: `c30376e94326f8674793c960b482eb532ffbf1f6`.
- Previously referenced renderer commit resolved locally: `da8dd156d1f24d4994978c29c3191869731d4a69`; it was not the pushed fork HEAD at audit.

## 2. Root causes confirmed

1. `src/lib/moments/boundary-repair.ts` selected ending anchors without a lower bound tied to `roughStartSec`.
2. Ending repair changed the start to the selected ending utterance start, collapsing 30–60 second candidates into short ASR fragments.
3. The filtered-array loop index was used as if it were the full-transcript index for `nextU` and following context.
4. Invalid/non-finite rough ranges and invalid constructed results did not fail closed.
5. Extension could cross `preferEndBeforeSec` or treat a distant preferred ceiling as unbudgeted expansion.
6. `src/lib/moments/two-pass.ts` clamped an invalid semantic range with `Math.min(start, end - 1)` rather than rejecting the contract violation.
7. Renderer CI installed no OpenCV but skipped the blocking visual suite, producing green pytest with four required tests skipped.

Negative duration is therefore classified as a production boundary correctness defect—not an ASR limitation. ASR fragmentation remains a separate semantic-quality limitation after the temporal fix.

## 3. Files changed

- `src/lib/moments/boundary-repair.ts`: window-local indexed search, preserved start ownership, controlled guarded extension, finite/ordered result validation, selected-anchor diagnostics.
- `src/lib/moments/two-pass.ts`: reject invalid semantic/guarded ranges before repair or finalization; removed 1-second clamp.
- `src/lib/moments/__tests__/boundary-repair-closure.test.ts`: BR-01..BR-12, extension guard regressions, ASR failure signature, deterministic generated invariants.
- `src/lib/moments/__tests__/two-pass-invalid-range-closure.test.ts`: caller-level end-before-start fail-closed regression.
- `scripts/real-media-prod-eval.ts`: canonical 10-episode production evaluator with strict JSONL output and explicit negative-range counts.
- `scripts/brief-v11-annotation-candidates.ts`: reviewer aid only; does not inject timestamps into production.
- `docs/evidence/*`: G1 manifest, G2 machine summary, G3 artifact classification, and manual worklist.
- Renderer `.github/workflows/ci.yml`: install from correct working directory, generate deterministic visual fixtures, verify `cv2` before pytest.
- Renderer `requirements.txt`: add `pytest`, `opencv-python-headless`, `fastapi`, `pydantic`, `uvicorn`, and `httpx` to the single CI dependency set.
- Renderer `render_service.py`: replace Windows-only `ctypes.windll` free-disk checks in `/readyz` and `/health` with cross-platform `shutil.disk_usage`.
- Renderer `.github/workflows/ci.yml`: install `ffmpeg` on the runner before pytest.
- Renderer `test_visual_regression.py`: remove missing-OpenCV skip; import must fail fast.

## 4. Tests added

- BR-01: old complete ending wholly before candidate cannot be selected.
- BR-02: deep filtered window keeps original full-array index and correct `nextU` classification.
- BR-03: in-window snap preserves rough start.
- BR-04: extension moves only the end.
- BR-05: no acceptable ending rejects without synthesized duration.
- BR-06: next-topic ceiling remains authoritative.
- BR-07: short ASR fragments do not collapse a long candidate to one final fragment.
- BR-08: overlap at rough start is allowed; wholly prior utterance is excluded.
- BR-09: end <= start rejects early.
- BR-10: non-finite timestamps reject early.
- BR-11: transcript start/end edges are safe.
- BR-12: identical input returns structurally identical output.
- Generated invariant loop: every non-rejected result is finite, ordered, non-negative, and within transcript bounds.
- Caller regression: invalid semantic end-before-start is rejected without clamp or repair fallback.

At least BR-01 was observed failing before the production fix (`received repaired`, expected `rejected`) and passing afterward. BR-03, BR-04, BR-06, BR-09, BR-10, and caller fail-closed were also observed RED before GREEN.

## 5. Local CI

### Miner

- `npm ci`: exit 0; 407 packages installed/audited. npm reported six high-severity dependency audit findings; no automatic major-version upgrade was applied because it is outside this brief.
- `npx tsc --noEmit`: exit 0, 0 errors.
- `npx vitest run`: exit 0, **266 passed** after final regressions.
- `npx eslint . --max-warnings 0`: exit 0, 0 errors, 0 warnings.
- Focused boundary/final-range suites: 26 passed.

### Renderer

CI-parity environment used only `requirements.txt`.

- Pre-fix reproduction: `test_visual_regression.py` → **4 skipped**, exit 0, because OpenCV was absent.
- Post-fix visual suite: **4 passed, 16 subtests passed, 0 skipped**.
- Full discovery: **205 passed, 44 subtests passed, 0 failed, 0 errors, 0 skipped**.

## 6. GitHub Actions

- Miner baseline run `31248230891` for `35de098...`: success.
- Miner final recovery run `31252910568` for `5d7be6f...`: **success**.
- Renderer pre-fix pushed-fork run `31205757569` for `1a04a5e...`: failure (missing fastapi/pydantic at collection).
- Renderer intermediate run `31252990091` for `034ec1a...`: failure (ffmpeg absent; readyz used Windows-only ctypes.windll).
- Renderer final recovery run `31253140819` for `f3e7f7d...`: **success**.

Both final exact-SHA CI runs are green.

## 7. G1

- Usable unique episodes: **10/10**.
- All ten video IDs are unique.
- All ten transcripts are real `youtube_asr`, non-empty, finite duration, and cached before evaluation.
- Timing precision is honestly `cue` with timing coverage `0`; none of the ten has trustworthy word-level timing.
- YouTube oEmbed titles/channels were checked live; transcript metrics came from a read-only cached DB snapshot.

Evidence: `docs/evidence/brief-v11-g1-corpus.json`.

## 8. G2

- Production path evaluated: **10/10 episodes**.
- Engine output was labelled `heuristic`; it is not reported as LLM success.
- Accepted clips per episode: `0,0,0,0,0,0,1,0,0,0`.
- Accepted total: **1** (Iqbal, 2097.48–2138.04, 40.56 s, score 80).
- Negative duration count: **0**.
- Remaining systemic rejection categories include ending confidence, start/finalization, ending incompleteness, too short, and one contamination rejection.
- Manual publishable annotations: **0/10 completed**.
- Manual hard negatives: **0/10 completed**.
- Top-1/Top-3 comparison: incomplete because the manual ground-truth corpus is incomplete and nine episodes have no accepted ranked output.

Evidence:

- `docs/evidence/brief-v11-g2-production-summary.jsonl`
- `docs/evidence/brief-v11-manual-annotation-worklist.json`

The result satisfies temporal diagnostic acceptance but not G2 quality acceptance. Per the systemic-zero rule, G3 cannot proceed using manually selected substitutes.

## 9. G3

- Current post-fix production-selected accepted clips available for G3: **1**, the Iqbal clip.
- Historical real MP4s for Iqbal, Kobe, and Kim are technically H.264, 1080×1920, yuv420p with AAC audio, but Kobe and Kim are not selected by the current post-fix production result.
- No truthful proof exists for >=2 genuine speaker-switch selections.
- No completed PASS/FAIL/N/A full-playback checklist exists for three qualified outputs.
- Synthetic six-second fixtures in renderer `evidence_out/` are explicitly not counted.

Evidence: `docs/evidence/brief-v11-g3-artifact-manifest.json`.

## 10. Known limitations

- ASR cue fragments have no word timing and frequently yield ending confidence 0.78 below the configured 0.82 threshold. Thresholds were not lowered.
- A classifier adaptation is not justified as a silent follow-up patch in this pass because the brief requires manual listening evidence across at least three usable episodes first. That evidence is not yet complete.
- GitHub Actions: final miner run `31252910568` and final renderer run `31253140819` are green on the exact recovery SHAs.
- Manual annotation and full playback require actual human media review; neither is fabricated here.

## 11. Final verdict

**BLOCKED**

Correctness recovery itself passed: invalid temporal construction is fixed, the 10-episode real run has zero negative durations, and both final GitHub Actions runs are green. Feature readiness is still blocked by:

1. G2 systemic low yield: 1 accepted clip across 10 episodes.
2. Missing 10 publishable + 10 hard-negative human annotations and Top-1/Top-3 comparison.
3. Missing two genuine speaker-switch production selections and 3/3 full playback reviews.

Reviewer tooling for the manual phase is ready in `docs/brief-v11-g2-g3-continuation-plan.md` and `docs/evidence/brief-v11-manual-annotation-worksheet.md` (10 episodes x top-4 candidates with watch links). The human review itself is intentionally left unfinished; it cannot be automated or fabricated.
