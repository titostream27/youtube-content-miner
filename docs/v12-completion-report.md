# Brief V12 Completion Report

**Date:** 2026-08-08
**Final verdict: BLOCKED**

## A. Repository state

| | Miner | Renderer |
|---|---|---|
| HEAD | `0b6f532eaf29f8d53b6726fa48c6406e518794d9` (V12 worktree branch `fix/brief-v12-candidate-quality`) | `5d91cbe8887ea2d10cea8af5b8a4b9566dc924fd` |
| Branch | `fix/brief-v12-candidate-quality` | `fix/brief-v11-renderer-recovery` |
| Git status | clean | clean |
| PRs | PR #5 open (V11 branch) + V12 PR opened after this report | PR #1 open |
| GitHub Actions | `0b6f532` success | `5d91cbe` success |

## B. Baseline

- Frozen corpus: 10 episodes (ids, language, provider, cues, duration, transcript SHA-256 in
  `docs/v12-baseline-audit.md`); all usable; timing precision cue-level, coverage 0.
- Previous G2 yield: 1 accepted clip across 10 episodes (Iqbal 2097.48–2138.04, score 80).
- Previous known defects: boundary negative duration (fixed V11, protected), start collapse (fixed),
  filtered/full-index confusion (fixed), G2/G3 blocked.

## C. Root-cause findings (evidence-backed, not guessed)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| H1 proposal starts too late | CONFIRMED (part) | 112/344 (32.6%) finalize start-gate rejects |
| H2 proposal ends too late | MINOR | 1/344 contamination; 53/344 incomplete endings |
| H3 proposal ends too early | MINOR | 53 ENDING_COMPLETE |
| H4 scoring ignores completeness | NOT REACHABLE | 2/344 survive to scoring; 1 below threshold, 1 accepted |
| H5 ranking wrong | NOT REACHABLE | only 1 scored above threshold; rank irrelevant |
| H6 ASR fragmentation | CONFIRMED (dominant) | 154/344 (44.8%) same 0.78<0.82 ending-confidence reject |
| H7 provider/parsing | NOT OBSERVED | no provider warnings; heuristic engine effective |
| H8 heuristic fallback degraded | NOT OBSERVED AS LOGGED FALLBACK | heuristic is effective engine; no fallback warnings |
| H9 topic transition weak | DISPROVEN systemic | 0.3% contamination rate |
| H10 duration distortion | MINOR | 22/344 (6.4%) too short |

Evidence files: `docs/evidence/v12-lineage.jsonl` (344 candidate rows), `docs/evidence/v12-lineage.stderr.log`.

## D. Code changes

Production code: **no semantic changes** (deliberate; see conservative decision).
Added:
- `scripts/v12-lineage-eval.ts` — diagnostic harness (production functions, strict JSONL; no threshold/prompt change).
- `src/lib/moments/__tests__/v12-candidate-quality-regression.test.ts` — CQ-01..CQ-19 matrix (20 rows incl. CQ-20 determinism evidence from rerun equality; CQ-13/14/15 protect V11 invariants).
- Docs: `docs/v12-baseline-audit.md`, `docs/v12-candidate-quality-analysis.md`, `docs/v12-human-gold-annotations.md`, `docs/v12-g2-evidence.md`, `evidence/brief-v12-gold-slots.json`.

Why no semantic repair in this pass: the brief's mandatory human gold set (§5, §26) is not
producible in this environment; without it, both candidate repairs (ending-confidence calibration,
start expansion) cannot be validated against "correct acceptances" and would be threshold/quality
gaming in disguise. The failure modes are now isolated to two earliest stages with exact counts,
which is the actionable repair plan.

## E. CI

- Miner tsc: 0 errors. Miner vitest: full suite pass (count recorded in GH Actions run).
- Miner eslint: 0 errors / 0 warnings.
- Miner GitHub Actions: pushed branch run green (exact SHA in PR).
- Renderer pytest: 205 passed + 44 subtests (unchanged, verification only).
- Renderer skipped: 0. Renderer GitHub Actions: green at `5d91cbe`.

## F. Human gold set

- Episodes annotated: 0/10 (framework + watch links ready: `docs/v12-human-gold-annotations.md`)
- Publishable annotations: 0/10
- Hard negatives: 0/10

## G. G2 before vs after

| metric | before (V11) | after (V12 diagnostic) |
|---|---|---|
| accepted production clips | 1 | 1 (identical clip) |
| zero-output episodes | 9/10 | 9/10 |
| ending-confidence rejects | high (V11 reason mix) | 154/344 (44.8%) measured |
| start-gate rejects | high (V11 reason mix) | 112/344 (32.6%) measured |
| contamination rejects | 8 (V11 count, one episode) | 1/344 (0.3%) |
| negative durations | 0 | 0 |
| gold recall | N/A | N/A (no gold) |

## H. G3

- Production-selected clips: 1 (below the required 3) → G3 not run.
- No new renderer work; renderer gate re-verified (pytest green, no visual skips).

## I. Known limitations

- No human listener: gold set, Top-1/Top-3 comparison, G3 playback reviews all unavailable.
- Heuristic engine: `AI_PROVIDER=deepseek` is configured, but no LLM warnings were observed; the
  observed engine is deterministic heuristic. LLM-path-specific hypotheses (H7) remain untested
  in this environment.
- ASR corpus has no word-level timing (coverage 0), so pause-based signals are the only timing cue.

## J. Mandatory agent notes (20 answers)

1. **Dominant root cause:** ASR-fragment endings consistently produce ending confidence 0.78
   below the 0.82 threshold (44.8% of all candidates), i.e. H6 — semantic closure signal is
   systematically under-powered on this corpus.
2. **Disproven:** H9 (topic contamination: 0.3%), and effectively H4/H5 (scoring never reachable).
3. **V11 regressions reappeared?** No — CQ-13/14/15 and the rerun both confirm zero negative
   durations and identical accept.
4. **Episodes with >=1 publishable production candidate:** 1/10 (Iqbal; Kobe kept at score 60
   below threshold — not publishable).
5. **Gold moments in Top-1 / Top-3:** N/A — no gold set.
6. **Rejected for mid-context start:** 112 (32.6%).
7. **Rejected for next-topic contamination:** 1.
8. **Provider/parser failures:** 0 logged.
9. **Fallbacks:** 0 logged fallback warnings; effective engine heuristic.
10. **Hard negatives accepted:** 0 (none annotated yet to test).
11. **Thresholds changed?** None.
12. **Prompts changed?** None — no prompt exists in the dominant failure path.
13. **Tests skipped?** 0.
14. **Renderer code changed?** No (this pass).
15. **G3 MP4s production-selected:** 0 (need >=3; 1 candidate exists).
16. **Genuine speaker-switch clips:** 0 proven.
17. **Human started-to-end playback:** No — no human playback review occurred; state is explicit.
18. **What remains uncertain:** whether recalibrated confidence/start expansion produce correct
    acceptances (needs gold), and the real LLM-path behavior in a provider-reachable environment.
19. **CI:** miner green at PR head; renderer green (5d91cbe).
20. **Stop condition hit:** yes — mandatory gold set cannot be produced in this environment.

## K. Definition of done checklist (brief §26)

| Gate | Status |
|---|---|
| Miner CI green local + GH | PASS |
| Renderer CI green local + GH | PASS |
| No relevant tests silently skipped | PASS |
| V11 boundary invariants remain green | PASS |
| 10 frozen usable episodes documented | PASS |
| 10+ human publishable annotations | **NOT MET (0)** |
| 10+ human hard negatives | **NOT MET (0)** |
| Candidate lineage evidence exists | PASS |
| Root cause demonstrated, not guessed | PASS |
| Top-1/Top-3 before-vs-after | BLOCKED (gold) |
| No negative-duration candidates | PASS |
| Systematic mid-context starts addressed | DIAGNOSED; repair blocked on gold |
| Systematic next-topic contamination addressed | PASS (near-zero already) |
| Known hard negatives not accepted | PASS (0 accepted) |
| >=3 production-selected publishable clips | **NOT MET (1)** |
| >=2 speaker-switch clips | NOT MET |
| 3 G3 MP4s through production path | NOT MET (blocked upstream) |
| ffprobe + QC + switch timeline | NOT MET |
| Representative frames | NOT MET (no new renders) |
| Human-vs-automated review disclosure | PASS (explicit) |
| Completion report consistent | PASS |
| No thresholds/gates weakened | PASS |

## Final verdict

**BLOCKED** — engineering diagnostics complete and honest; mandatory human listening corpus and
>=3 publishable production-selected clips do not exist, and the agent must not fabricate either.