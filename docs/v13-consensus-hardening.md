# V13 Consensus Hardening (Phase B)

**Date:** 2026-08-09

## What changed

The V12R consensus (`src/lib/v12r/consensus.ts`) only vetoed `hard_negative` and
`next_topic_leakage`. V13 adds a hardened layer (`src/lib/v13r/consensus-v2.ts` →
`decideConsensusV13`) that reuses the V12R decision core and then applies the
complete critical-veto rule set (brief §4.1) with strict-majority semantics:

| Veto condition | Majority rule |
|---|---|
| `next_topic_leakage == true` | majority of content verdicts |
| `hard_negative == true` | majority of content verdicts |
| `ending_complete == false` | majority of content verdicts |
| `start_complete == false AND context_independence == false` | majority of content verdicts |

- Majority = strictly more than half of the judges that produced a content
  verdict (2-of-3 when Judge C invoked; **both** A and B when only two
  verdicts exist).
- A single dissenting flag on a 2-judge pair is a disagreement → Judge C is
  invoked; if unavailable the verdict becomes `REVIEW`.
- The **exact veto reason is persisted** (`veto_reason`, e.g.
  `majority(ending_complete=false) ; majority(start_complete=false && context_independence=false)`).
- Provider/parser failures are never content verdicts (unchanged, V12R R6/R7):
  missing votes → `REVIEW` unless the remaining votes are unanimous FAIL.
- The downgrade only fires on `PASS`; `FAIL` and existing `REVIEW` verdicts
  are untouched.
- Labels are versioned (`benchmark_version`, `V13_BENCHMARK_VERSION` env,
  default `v13.0`) — SA-20.

## Re-consensus of the V12R 51-candidate benchmark (offline)

Judge outputs are persisted in `evidence/v12r/judge_outputs.jsonl`; V13
re-derived every candidate's A/B/C calls from that file (no new LLM calls,
deterministic), applied `decideConsensusV13`, and compared labels against the
V12R consensus.

Artifacts:

- `evidence/v13/consensus_labels_v13.jsonl` — hardened labels (51 rows + expansion append)
- `evidence/v13/consensus_label_changes.jsonl` — 0 rows
- `evidence/v13/hardening_summary.json`

Result:

```json
{ "candidates_rejudged": 51, "pass": { "old": 2, "new": 2, "lost": 0 },
  "review": 7, "fail": 42, "label_changes": 0, "changes": [] }
```

Interpretation: the two V12R silver-PASS candidates (Jagger/Millie and one H1-repaired Jagger candidate) are judged internally consistent — their judges did not contradict `publishable=true` with incomplete endings or start-dependent openings — so hardening changes nothing on the accepted baseline.
"if a previously silver-PASS candidate flips to FAIL it is removed" — no flip
occurred).

## Regression tests

`src/lib/v13r/__tests__/v13-consensus.test.ts` covers every veto combination:

- SA-06 majority `ending_complete=false` with publishable=true → cannot PASS
- SA-07 majority `start_complete=false && context_independence=false` → cannot PASS
- SA-08 provider/parse failure on one judge → no fabricated label (REVIEW unless unanimous FAIL)
- A/B agree-PASS with one veto → Judge C invoked / REVIEW semantics
- 2-of-3 PASS with majority veto → downgraded REVIEW
- Clean PASS preserved; FAIL preserved.