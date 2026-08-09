# V12R G2 Evidence — Automated Re-run Without Human Gold

**Date:** 2026-08-08
**Brief section:** Phase N (§17)
**Evidence:** `evidence/v12r/production_g2.jsonl`

## 1. Run

The same production functions as the V12 lineage eval
(`detectMoments` → `twoPassHighlightSelection` → guards → repair →
finalize → heuristic scoring) were re-run over the frozen 10-episode corpus.
**No semantic production change exists in V12R** (H6/H1 kept experimental),
so the funnel is expected to match the V12 baseline exactly — this is a
regression confirmation, not a redo of the diagnosis.

## 2. Per-episode result (summary)

| episode | rough | kept | accepted | silver top1 |
|---|---|---|---|---|
| I6wCuvvaRPI (Kim) | 40 | 0 | 0 | — |
| GOqEl4ADyVk (Tom) | 40 | 0 | 0 | — |
| 2HLGcRpw1hc (Jagger) | 36 | 0 | 0 | — |
| UZ1kCEGjYX0 (Damon) | 39 | 0 | 0 | — |
| Hb2rKGfIOrM (Obama) | 14 | 0 | 0 | — |
| g2cQ2kD6lzs (Kobe) | 25 | 1 | 0 | — |
| Ive926sC6mc (Iqbal) | 40 | 1 | **1** | FAIL* |
| 3NSC5nps3OM (Idgitaf) | 40 | 0 | 0 | — |
| 376JmatmnaI (Millie) | 40 | 0 | 0 | — |
| XuoqKYxDHVc (Musk) | 30 | 0 | 0 | — |
| **Total** | **344** | **2** | **1** | — |

\* The single production-accepted candidate (Iqbal `Ive926sC6mc`
2097.48–2138.04) was independently judged **FAIL** by both Judge A and Judge
B (silver consensus). The benchmark therefore contradicts the heuristic
acceptance signal for that clip: production accepted it, the semantic judges
did not. This is exactly the kind of signal the human-gold bottleneck used
to provide.

## 3. Automated G2 acceptance checks (brief §17.1)

| Criterion | Required | Actual | Status |
|---|---|---|---|
| 10/10 frozen episodes evaluated | 10 | 10 | ✅ |
| Zero negative-duration candidates | 0 | 0 | ✅ |
| No systemic next-topic contamination | — | 1 contamination reject (unchanged) | ✅ |
| Consensus evidence exists for Top-N production candidates | yes | Top-1 accepted has consensus (FAIL); Top-N keepers have consensus | ✅ |
| ≥3 production-selected candidates receive silver PASS | ≥3 | **0** | ❌ |
| ≥2 silver PASS candidates are genuine multi-speaker material | ≥2 | 0 PASS candidates have speaker labels (cue-level ASR has no speaker IDs) | ❌ |
| Known hard-negative patterns not promoted | yes | no hard-negative pattern reached PASS | ✅ |
| Judge disagreement + independence tier disclosed | yes | 80.4% agreement, 19.6% Judge C, Good+ tier | ✅ |

## 4. Honest conclusion

G2 automated acceptance is **partially met**. The rerun itself is clean
(10/10 episodes, zero negative durations, deterministic), and the silver
layer is auditable. But the required **≥3 production-selected silver PASS**
clips and **≥2 multi-speaker PASS** clips are NOT met: the only production
accepted clip is silver FAIL, and the corpus transcripts carry no speaker
diarization. These are data-level limitations, not pipeline defects —
disclosed rather than papered over (R11).