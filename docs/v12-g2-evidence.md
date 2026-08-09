# V12 G2 Evidence

**Date:** 2026-08-08
**Corpus:** frozen 10 episodes (see `docs/v12-baseline-audit.md`, hashes recorded).
**Method:** `scripts/v12-lineage-eval.ts` on the production pipeline, strict JSONL:
`docs/evidence/v12-lineage.jsonl` (355 lines: 344 candidates + 10 summaries + EVAL_DONE).
No thresholds/prompts/code semantics changed. All numbers below are from that file.

## Per-episode summary

| episode | rough | kept | accepted | dominant rejection |
|---|---|---|---|---|
| I6wCuvvaRPI | 40 | 0 | 0 | ending confidence / start gate |
| GOqEl4ADyVk | 40 | 0 | 0 | ending confidence / start gate |
| 2HLGcRpw1hc | 36 | 0 | 0 | ending confidence / start gate |
| UZ1kCEGjYX0 | 39 | 0 | 0 | ending confidence / start gate |
| Hb2rKGfIOrM | 14 | 0 | 0 | ending confidence / start gate |
| g2cQ2kD6lzs | 25 | 1 | 0 | kept, scored 60 (< 70) |
| Ive926sC6mc | 40 | 1 | 1 | kept, PUNCHLINE 0.82, score 80 |
| 3NSC5nps3OM | 40 | 0 | 0 | ending confidence / start gate |
| 376JmatmnaI | 40 | 0 | 0 | ending confidence / start gate |
| XuoqKYxDHVc | 30 | 0 | 0 | ending confidence / start gate |
| **Total** | **344** | **2** | **1** | — |

## Required metrics (brief Phase D)

| Metric | Value |
|---|---|
| Gold recall @1 / @3 | NOT CALCULABLE — no human gold set exists (0/10 episodes annotated) |
| Start error / End error | Blocked on gold |
| Standalone failure rate | Proxy: 112/344 (32.6%) rejected at finalize start gate (mid-context) |
| Payoff missing rate | Proxy: 53/344 (15.4%) ENDING_COMPLETE rejects |
| Next-topic contamination rate | 1/344 (0.3%) — H9 disproven as systemic |
| Hard-negative promotion | 0 known hard negatives promoted (gold hard negatives pending) |
| Zero-output rate | 9/10 episodes (0.9) |
| Fallback rate | 0 explicit fallback warnings in this run; effective engine = heuristic |
| Negative durations | 0 |

## Before vs after (the only honest comparison available)

The V12 diagnostic pass intentionally changes no semantics, so "after" equals "before":
- Accepted clips: 1/10 (same Iqbal clip as V11, identical window and score).
- Kept-through-boundary candidates: 2/344.
- This is the baseline any future semantic repair (ending-confidence calibration with pause
  evidence; proposal start expansion to valid setup) must beat — after human gold exists.

## V12 G2 acceptance checklist (brief §18.1)

- [x] 10/10 frozen episodes evaluated (no provider outage recorded in this run)
- [x] Zero negative-duration candidates
- [x] Every candidate preserves V11 temporal invariants (regressions CQ-13..15)
- [ ] Human gold annotations for all 10 episodes — **NOT AVAILABLE (mandatory, blocking)**
- [ ] Top-3 material improvement — blocked on gold + no semantic change made
- [ ] Systematic mid-context starts eliminated/reduced with evidence — diagnosis recorded; repair blocked on gold
- [ ] Systematic next-topic contamination eliminated/reduced — already near-zero (0.3%)
- [ ] Known hard negatives not promoted — 0 promoted; hard negatives pending
- [ ] >=3 genuinely publishable production-selected clips — **1 only**
- [ ] >=2 with genuine speaker-switch material — 0 proven

**Gate verdict: BLOCKED** (mandatory human listening corpus missing; fewer than 3 publishable
production clips, honest count 1).

## Conservative decision (brief §27 directive)

No threshold was lowered, no CI weakened, no synthetic clip counted. A zero-output episode is
preferred to a context-broken Short; the diagnostic evidence says the bottleneck is semantic:
ending-confidence under-signal on punctuation-less ASR (44.8%) and proposal start completeness
(32.6%).