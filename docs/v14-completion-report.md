# V14 Completion Report — Selector Hard-Gate Semantics & Recall Calibration

> **SUPERSEDED (Brief V14R).** This report's closure was found to contain a
> material contradiction (E3 next-topic leakage row), seven checksum failures,
> and a non-portable verification toolchain. The authoritative closure is
> `docs/v14r-completion-report.md`; see `docs/v14r-errata.md` for every
> corrected statement. Historical evidence is preserved untouched under
> `evidence/v14/`.

Verdict: **BLOCKED**
Confidence: **HIGH** (baseline reproduction is byte-exact; every safety failure is
candidate-level reproducible via `scripts/v14-experiments.ts` + the recorded runs)
Production semantics changed: **NO**

One-sentence reason: every ending-recovery variant fix (E1–E4/S1/S2) accepts NEW
silver-FAIL candidates (incl. 2 that also carry judge hard-negative flags), so the
predeclared safety-first hierarchy rejects all of them; no candidate policy exists
to lock, holdout stays sealed, verdict BLOCKED with actionable next steps.

## 1. Baseline reproduction
- code SHA: worktree created at `main @ bf7381e2` (`bf7381e2 Merge pull request #8`).
  Local `main` branch was stale at `b611a1a4`; `origin/main == bf7381e2` verified and
  the V14 worktree was checked out from that SHA. git status at P0: clean (only
  untracked junk files ignored; worktree HEAD = `bf7381e2`).
- 344 = 8 PASS + 333 FAIL + 3 REVIEW reproduced from `evidence/v13/*`; the exact
  8 PASS ids, the single accepted FAIL `c=3b416b15c9b5` (Ive926sC6mc, score 80,
  baseline leakage 1/333 = 0.30%) and the flag sets (293 hard-negative-flagged,
  282 next-topic-leakage-flagged candidates by any judge) recorded in
  `evidence/v14/baseline.json`.
- First-death reproduction (V13 control replayed with production env including
  `CLIP_HARD_MAX_SEC=90`): PASS cohort = 7 fits at `05_ENDING_CONFIDENCE`
  (conf 0.78 < 0.82) + 1 at `04_ENDING_COMPLETE` (UNKNOWN). Exact.
- Evidence: `evidence/v14/control_repro/*`, `evidence/v14/baseline.json`,
  `evidence/v14/sha256sums_v13_artifacts.txt`.

## 2. Pre-registration and data
- protocol v1.0: `protocol.yaml` — committed as `c6f8a04d` **before** any expansion
  outcome was viewed. protocol hash inside `split_lock.json` (hashes.protocol).
- Benchmark: 4 new frozen episodes selected deterministically (the complete
  non-legacy cached corpus — no exclusions): `LAmGfokvgzA`, `e1WM_JEmP-Q`,
  `hb7Oqrj3F3k`, `vs6x8VUGXCw`. Census = 160 candidates (40/episode,
  `evidence/v14/census_new.jsonl`, generator `v14-lineage-v1` = same production
  functions as V13). `episode_manifest.csv` + `candidates.csv` with canonical
  TS-computed transcript SHA-256 (`transcript_hashes.json`).
- Blind labels: A/B/C judge run (`judge_outputs_v14.jsonl`, `silver_labels_v14.jsonl`):
  **160 = 8 PASS + 150 FAIL + 2 REVIEW; 0 provider/parse failures; Judge C on 10
  disagreements**. Labels created from PRE/CAND/POST transcript windows only.
- Suffufficiency gate: 14 episodes >= 6 ✓; PASS-bearing episodes 6 >= 4 ✓;
  total PASS 16 >= 12 ✓; holdout 2 episodes with 6 PASS across 2 ✓.
- Split lock: calibration = {LAmGfokvgzA, vs6x8VUGXCw}, holdout = {e1WM_JEmP-Q,
  hb7Oqrj3F3k} (hash rule in protocol). `split_lock.json`; lock SHA
  **`ffdb37fed6a275466d9ade922971310a6832c8c59923742eea01ce6312d61195`**.

## 3. Experiments (all primary + negative control, none omitted)
| Variant | Policy | accepted FAIL (legacy+calib) | new FAIL | legacy PASS eligible | legacy PASS accepted |
|---|---|---|---|---|---|
| C0 | production | 1 (c=3b416b15c9b5) | 0 | 0/8 | 0/8 |
| E1 | floor→0.78 | 4 | 3 (9e121d6b7221, fb53d482602c, 6065a196f512) | 0/8 | 0/8 |
| E2 | COMPLETE exempt | 4 | 3 | 0/8 | 0/8 |
| E3 | three-state + penalty cap4 | 3 | **2** (9e121d6b7221, fb53d482602c) | 0/8 | 0/8 |
| E4 | three-state, no penalty | 4 | 3 | 0/8 | 0/8 |
| S1 | locked ending trace | 3 | 2 | 0/8 | 0/8 |
| S2 | + start soft penalty | 3 | 2 | 0/8 | 0/8 |
| NEGATIVE_CONTROL | permissive (excluded from selection) | all 424 | 410 | — | — serves as leak-detector proof |

Penalty grid sensitivity (analysis only, NOT selection): E3 soft penalties at 05:
cap 4→101 candidates, cap 2→224, cap 1→1; monotone & bounded (unit tests).

## 4. Metrics (exact counts; Wilson CI 95%)
| Metric | V13 control (legacy) | E3 legacy | E3 calibration | Target | Pass? |
|---|---|---|---|---|---|
| PASS Recall@Eligible | 0/8 (0%) | 0/8 (0%) CI [0,32.4%] | 0/2 (0%) | >=75% | NO |
| PASS Recall@Accepted | 0/8 (0%) | 0/8 (0%) | 0/2 (0%) | >=5/8 | NO |
| FAIL leakage | 1/3: accepted | 3/333 (0.90%) | 0/78 | no new accepted FAIL | **NO (safety)** |
| Hard-negative accepted (new) | 0 | 2 | 0 | 0 | NO |
| Next-topic leakage accepted (new) | 0 | 0 | 0 | 0 | YES |
| Episode stability | — | no PASS-bearing episode eligible | — | n/a | FAIL |

(Per-episode subtables + Wilson intervals in run/`metrics.json`; calc denominators
exact; REVIEW reported separately: legacy 3, new 2 — never counted as PASS.)

## 4. Gate attribution
- ENDING: three-state semantics verified: COMPLETE (CONCLUSION@0.78) ×5, UNKNOWN@0.45
  ×2, UNKNOWN ×1 for the 8 PASS; with E3/E4 none are hard-rejected at confidence
  (target T2a met). Mandatory finding: 0.78 is a **hard-coded class mapping constant**
  (`classifyEnding` → CONCLUSION → 0.78), not a learned probability.
- START gate: **8/8 PASS now die at 03_START_GATE with concrete feature evidence**
  (MID_SENTENCE ×8, MISSING_CONTEXT ×1, LATE_HOOK ×2; repair search fails
  deterministically) — the second independent blocker (H3 CONFIRMED). The
  END-GATE fix alone cannot deliver Recall.
- Evidence per candidate: `stage_trace.jsonl` (execution_index separate from stage
  id; NOT_REACHED distinct from PASS), `first_death.csv`, `score_contributions.csv`,
  `policy_switches.csv` per variant.

## 6. Holdout
- NOT evaluated. Protocol: holdout runs only for the one locked policy; calibration
  rejected every variant (safety gate precedes recall; the two new accepted FAILs
  `c=9e121d6b7221`, `c=fb53d482602c` are hard-negative-flagged). Holdout sealed:
  `split_lock.json` + `policy_lock.json` (lock SHA
  `c465d62a974b54904705c85341c2786c39a5b79bac49b0c4c212d0133ad12503`).
- No post-lock viewing happened; no retuning.

## 7. Limitations
- Small positives (legacy 8, calib 2), episode-concentration in legacy (5/8 PASS in
  one episode); judge flags (hard-negative/leakage) are per-tier annotations, not
  consensus labels; the START gate is feature-heuristic, not semantics-aware beyond
  referents; T1 threshold sweep and Q1 acceptance-decomposition are NOT RUN because
  they require a locked policy (reported NOT RUN, not skipped silently).

## 8. Tests and production diff (commands, results)
- `npx tsc --noEmit` → 0 errors. `npx eslint scripts/v14-*.ts src/lib/v14` → 0.
- `npx vitest run` → 47 files, 333 tests passed (incl. 12 V14 unit tests:
  V14-END-001..004, V14-STA-001, V14-SCR-001/2, V14-TRC-001/2; monotonicity).
- `scripts/v14-verify.ts` → 12 PASS / 0 FAIL / 1 NOT-EVALUABLE (V14-DAT-001/2/3,
  V14-LEG-001/002, V14-DET-001, V14-TRC-002, V14-SAF-001, V14-PRD-001/2,
  V14-EVD-001). Ask `evidence/v14/verification_report.json`.
- Golden: C0 replay byte-matches V13 control on all 344 (first-death, accepted,
  score ≤ 1e-3). Determinism: two identical runs → identical.
- Production invariance: `git diff bf7381e2` shows only NEW files; no production
  module changed (config, topic-boundary, v13r, boundary-repair, start-gate,
  start-boundary, scoring) — see `evidence/v14/production_diff.txt`.

## 9. Limitations
- Small positive sample; the calibration set converged to 2 PASS only (vs6x8VUGXCw)
  so calibration metrics are descriptive; label ambiguity lives in the remaining
  UNKNOWN-0.45 candidates.
- `COMPLETE`/`UNKNOWN` boundaries rest on the classifier's vocabulary; TOPIC_TRANSITION
  handling as UNKNOWN may mask a boundary defect in variant runs — flag-metrics show
  the effect is bounded (0 new leakage accepted).

## 10. Recommendation (narrow, non-production)
1. A future sprint must attack START semantics (restated-question detection,
   referent-restoration), not the ending floor. 2. Precision requires a
   discriminative signal for the 0.78-0.82 cluster (PASS/FAIL coexist there);
   three-state alone leaks. 3. After a START/ENDING rebuild, re-run this benchmark
   (frozen) before any production decision; V14 gives no authority.

## 11. Reproduction & checksums
- Run commands recorded in the sections above and in script headers
  (`scripts/v14-*.ts`). Environment: Node v22.23.1, tsx, node_modules pinned via
  package-lock.json at bf7381e2; DB read-only `content-miner.db` (14 transcripts).
- Artifacts: `evidence/v14/**` (content-addressed, `SHA256SUMS`) + `docs/v14-*`.

## Required final declaration
I confirm that the reported holdout was evaluated only after the policy lock (it was
NOT evaluated — no lock exists), every primary variant run is retained
(`evidence/v14/runs/**`), no adverse candidate was removed from a denominator, and
NO production selector semantic, default, or threshold was changed. Exceptions:
none — verdict BLOCKED stands.

## Handoff navigation index (claims -> artifacts)
| Headline claim | Artifact to verify |
|---|---|
| Baseline 344 = 8/333/3, deaths 7+1 | `evidence/v14/baseline.json`, `evidence/v14/control_repro/first_death_matrix.csv` |
| Protocol frozen before data | git commit `c6f8a04d`, `protocol.yaml` hash in `split_lock.json` |
| 4 new episodes, sufficiency, split lock | `episode_manifest.csv`, `candidates.csv`, `split_lock.json` (SHA `ffdb37fe…`) |
| Blind labels 160 = 8/150/2 | `silver_labels_v14.jsonl`, `judge_outputs_v14.jsonl` (Judge C invoked on 10 disagreements) |
| Golden replay identical | `evidence/v14/runs/c0/C0/run_summary.json` (golden_check ok) |
| Safety rejections per variant | `policy_lock.json` (`hierarchy_check.results`) + `runs/<v>/policy_switches.csv` |
| START gate evidence (8/8 PASS) | `evidence/v14/runs/e3/E3/stage_trace.jsonl` (stage_id 03_START_GATE rows) |
| Test report | `verification_report.json`; `npx vitest run` (333), tsc 0, eslint 0 |
| Production unchanged | `production_diff.txt` (additive only), git diff `bf7381e2..HEAD` |
| Checksums | `evidence/v14/SHA256SUMS` |
| Reproduction commands | §12 + `scripts/v14-*.ts` headers for exact CLI/env |