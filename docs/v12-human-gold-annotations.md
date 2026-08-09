# V12 Human Gold Annotations

**Status: PENDING — no human listening corpus exists yet.**

The brief (§5, §26) requires, per frozen episode, at least one clearly publishable moment and one
hard negative, based on listening to the real media. Automated reviewers are explicitly not allowed
to substitute for this. This document is the framework a human reviewer fills in; it contains
machine-extracted candidate excerpts and watch links to make the review cheap.

## How to fill

1. For each episode below, open the watch link(s), listen to the referenced windows and the
   surrounding context.
2. Decide the publishable moment: `manual_start_sec` / `manual_end_sec`, and the 7 fields of the
   schema (hook_present, setup_sufficient, payoff_present, ending_complete,
   next_topic_contamination, context_dependency, speaker_turn_pattern).
3. Decide one hard negative (tempting but NOT standalone): setup-only, mid-answer, sponsor, or
   dependent reference.
4. Write results into `docs/evidence/brief-v12-gold-slots.json` and set `status: COMPLETE` per
   episode; the gate flips to PASS only when all 10 are complete.

Schema per annotation (from the brief):
episode_id, annotation_id, label (PUBLISHABLE | HARD_NEGATIVE), manual_start_sec, manual_end_sec,
hook_present (yes/no), setup_sufficient (yes/no), payoff_present (yes/no), ending_complete (yes/no),
next_topic_contamination (yes/no), context_dependency (NONE|LOW|MEDIUM|HIGH), speaker_turn_pattern,
why_publishable_or_negative, annotator_notes.

## Machine-prepared candidate excerpts (from v12-lineage.jsonl, kept candidates)

Kept candidates (survived boundary gates) that a reviewer should listen to first:

| episode | final_start | final_end | ending | confidence | final_score | accepted |
|---|---|---|---|---|---|---|
| Ive926sC6mc | 2097.48 | 2138.04 | PUNCHLINE | 0.82 | 80 | yes |
| g2cQ2kD6lzs | see lineage | see lineage | see lineage | see lineage | 60 | no (below 70) |

## Per-episode watch entry points (rough candidates, first 4 per episode)

From `docs/evidence/brief-v12-lineage.jsonl` (rough windows only; NOT gold, NOT production output):

| episode | watch link template |
|---|---|
| I6wCuvvaRPI | https://youtu.be/I6wCuvvaRPI?t=<rough_start> |
| GOqEl4ADyVk | https://youtu.be/GOqEl4ADyVk?t=<rough_start> |
| 2HLGcRpw1hc | https://youtu.be/2HLGcRpw1hc?t=<rough_start> |
| UZ1kCEGjYX0 | https://youtu.be/UZ1kCEGjYX0?t=<rough_start> |
| Hb2rKGfIOrM | https://youtu.be/Hb2rKGfIOrM?t=<rough_start> |
| g2cQ2kD6lzs | https://youtu.be/g2cQ2kD6lzs?t=<rough_start> |
| Ive926sC6mc | https://youtu.be/Ive926sC6mc?t=<rough_start> |
| 3NSC5nps3OM | https://youtu.be/3NSC5nps3OM?t=<rough_start> |
| 376JmatmnaI | https://youtu.be/376JmatmnaI?t=<rough_start> |
| XuoqKYxDHVc | https://youtu.be/XuoqKYxDHVc?t=<rough_start> |

(The exact rough windows are in the lineage JSONL — every candidate row has rough_start_sec,
rough_end_sec, and a 200-char proposal excerpt.)

## Why this gate cannot be closed by the agent

The agent cannot listen. Text-only scoring (pipeline salience, heuristic dimensions, previous
auto-review) is diagnostic evidence, not listening evidence. Any annotation filled in by an agent
would be evidence laundering (brief §1). Therefore the completion report will record:

- Episodes annotated: 0/10
- Publishable annotations: 0/10
- Hard negatives: 0/10
- Gate verdict: BLOCKED (missing mandatory human gold set)