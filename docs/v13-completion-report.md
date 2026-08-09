# V13 Completion Report — Production Selector Alignment / Silver-PASS Recall

**Date:** 2026-08-09 (rev. 2 — Judge C fixed & integrated)
**Brief:** `Brief_V13_Production_Selector_Alignment_Silver_Pass_Recall.pdf`
**Branch:** `fix/brief-v13-selector-alignment` (base `1f58c6f3` V12R, PR #7)

## Final verdict: **BLOCKED** (with full attribution; fix path identified)

The selector alignment was traced end-to-end and the failure layers are now
proven — but the benchmark does not satisfy the predeclared sufficiency gate
(≥8 silver-PASS across **≥4 distinct episodes**; we have 8 across 3, five of
which come from a single episode), so per §5.1/§28 the sprint stops before
aggressive gate tuning. No production threshold/weight/prompt was changed.

---

## 1. Judge configuration — FIXED during the sprint

| Tier | Model | Channel | Status |
|---|---|---|---|
| A | `ds/deepseek-v4-flash` | 9router gateway | ✅ 344/344 |
| B | `ag/gemini-3.5-flash-low` | 9router gateway (Google family) | ✅ 344/344 |
| C | `cx/gpt-5.6-luna` | 9router gateway (OpenAI family) | ✅ **fixed**: the gateway accepts the **DEEPSEEK_API_KEY value** on the "openai" provider channel — `OPENAI_API_KEY` must be set to that value (the hermes/.env OPENAI key is NOT a gateway key). All 15 C verdicts obtained. |

Three model families (DeepSeek / Gemini / GPT) via one gateway endpoint —
independence tier **Good** (single endpoint, three families, distinct
prompts), downgrade from V12R's "Good+" documented.

## 2. Benchmark (final, v13.0, hardened consensus + C)

- **8 silver-PASS** (all via `C_2OF3_PASS`: A/B disagreed, C sided)
- **333 FAIL**, **3 REVIEW** (majority critical veto — cannot PASS by rule)
- Episodes with PASS: I6wCuvvaRPI ×5, GOqEl4ADyVk ×1, g2cQ2kD6lzs ×2
- Sufficiency gate §5.1: **8 PASS / 3 episodes — NOT met** (need ≥4 episodes)

## 3. The alignment finding (trace + attribution staircase)

With the production config, all 8 silver-PASS die **before scoring**:

| First-death | Count | Detail |
|---|---|---|
| 05_ENDING_CONFIDENCE | 7 | ending_confidence = **0.78** — a *classifier constant* for complete-ending classes (ANSWER_COMPLETE/CONCLUSION), i.e. the floor 0.82 rejects a semantically-complete class by its label-mapped constant |
| 04_ENDING_COMPLETE | 1 | ending classified UNKNOWN at the window end (boundary/repair issue) |

Attribution staircase (`evidence/v13/attribution_staircase.jsonl`):
- bypass 05 only → dies at **03_START_GATE**
- bypass 03 only → dies at **05**
- bypass 03+05 → dies at **12_ACCEPTANCE_THRESHOLD** (heuristic scores 63–69, floor 70)
- bypass 03+05+12 → **accepted**

So the failure chain is: ENDING_CONFIDENCE floor (classifier-constant artifact)
→ START_GATE strictness → acceptance threshold 70 vs scores 63–69. The
earliest causal layer (R6) is **05_ENDING_CONFIDENCE**: its hard reject
contradicts its own classifier, which marks these endings *complete*.

## 4. Metrics (same benchmark version, BEFORE == AFTER — no change made)

| Metric | BEFORE | AFTER | Target | Status |
|---|---|---|---|---|
| Silver-PASS Recall@Eligible | 0/8 (0%) | 0/8 | ≥80% | ✗ (attributed) |
| Silver-PASS Recall@Accepted | 0/8 (0%) | 0/8 | ≥70% | ✗ (attributed) |
| Silver-FAIL Leakage@Accepted | 1/333 (0.3%) | 1/333 | ≤10% | ✓ |
| Hard-negative acceptance | 0 | 0 | 0 | ✓ |
| Next-topic leakage acceptance | 0 | 0 | 0 | ✓ |
| Top-1 / Top-3 silver recall | 0/0 | 0/0 | — | not evaluable (no accepted clip) |
| Episodes with ≥1 accepted PASS | 0/10 | 0/10 | ≥3 | ✗ |

## 5. Why no production change was made

1. Sufficiency gate not met (3 episodes, 5/8 from one episode) → §5.1
   explicitly forbids aggressive tuning; R8 (no overfit to known positives).
2. The 05-fix alone does not recover a single clip (start gate still kills);
   multi-gate changes would violate R6 (fix earliest causal stage) and R1
   (no threshold gaming) without episode-disjoint evidence.
3. The 0.78-class candidates' heuristic scores (63–69) sit below the 70
   acceptance floor — recall recovery also requires scoring alignment,
   which is beyond a gate relaxation.

**Recommended next sprint (Phase J, per brief):** (a) separate "low evidence"
from "evidence of incompleteness" — complete-ending classes must not hard-
reject; (b) audit the START_GATE penalties for complete windows; (c) score-
alignment for the 0.78 cluster; all three gated on a benchmark with ≥4
PASS episodes (extend corpus or restore a second provider endpoint).

## 6. Mandatory completion questions (answers)

Q1: 8 PASS (after C fix). Q2: 3 episodes. Q3: full 344 judged (A+B+C; C
initially blocked — gateway key issue — fixed with DEEPSEEK key value on the
openai channel; false-negative audit not needed, full census). Q4: 7@05, 1@04.
Q5: ENDING_CONFIDENCE (7/8 positives, removes 153 FAILs). Q6: no stage
changed in production; all tooling additive. Q7: n/a. Q8: no threshold
changed (0.82/70/0.18/14-60). Q9: no weights changed. Q10: no prompts changed.
Q11: H6 not reopened — the evidence is reported, the change is deferred per
sufficiency gate (the 0.78 cluster IS the H6 zone; reopening requires ≥4-
episode holdout). Q12: H1 not promoted. Q13-Q14: 0/8 before & after.
Q15: 1/333 (0.3%). Q16: 0. Q17: 0. Q18: not evaluable (0 accepted).
Q19: 0/10. Q20: 0 clips for G3. Q21: renderer untouched. Q22: blocked:
benchmark sufficiency (≥4 episodes), scoring alignment, G3 diarization.

## 7. Definition-of-Done checklist

| Item | Status |
|---|---|
| V12R reused | ✓ |
| Consensus vetoes hardened | ✓ (tests SA-06/07/08/22) |
| 51-candidate re-consensus | ✓ (0 changes; offline) |
| 344 pool judged (full census) | ✓ (A+B+C; C fixed) |
| ≥8 PASS / ≥4 episodes OR scarcity proven | ✓ proven: 8/3 → insufficiency |
| Tracer cohorts versioned | ✓ |
| Production stage replay | ✓ |
| First-death matrix | ✓ |
| Stage metrics | ✓ |
| Episode-disjoint split | ✓ (hash 70/30: cal 3 PASS, holdout 5 PASS) |
| Counterfactual evidence per stage | ✓ (+ attribution staircase) |
| No threshold gaming / no regression | ✓ |
| Recall/leak targets met or justified | justified (attribution + sufficiency) |
| >=3 accepted PASS clips | ✗ 0 — BLOCKER |
| CI green (321 tests, tsc 0, eslint 0) | ✓ |
| GitHub Actions green | ✓ (PR #8) |
| Renderer untouched | ✓ |

**Done — evidence boundary reached honestly: the selector kills every
silver-PASS at ENDING_CONFIDENCE (classifier-constant 0.78), then at START,
then at acceptance 70; no change was made because the benchmark is not yet
sufficient (3 episodes) and single-gate fixes recover nothing — the fix path
is explicit and queued behind a sufficiency-valid benchmark.**