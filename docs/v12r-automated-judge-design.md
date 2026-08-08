# V12R Automated Judge Design

**Date:** 2026-08-08
**Brief section:** Phase B-H (benchmark), Phase E (rubric), Phase F (consensus)

## 1. Objective

Replace the blocked human-gold step (0/10 populated) with an auditable
automated silver-gold consensus benchmark strong enough for development and
regression decisions. The benchmark evaluates candidate **semantics**
(context, setup, payoff, ending, next-topic leakage), never just the
production score.

## 2. Architecture

```
FROZEN V12 CORPUS (10 episodes, 344 candidates)
        |
v12r-sample.ts  (deterministic stratified sample, seed 20260808)
        |
        +----------------------------+
        | Judge A (DeepSeek, 9router) |
        | Judge B (Gemini, OpenRouter)|
        | Judge C on disagreement    |
        +----------------------------+
        |
Deterministic consensus (consensus.ts)
        |
SILVER-GOLD LABEL: PASS / REVIEW / FAIL
        |
Counterfactual experiments (H6 pause-aware confidence, H1 start expansion)
        |
Before/after metrics + promotion decision
```

## 3. Judge independence (Phase D)

| Tier | Model | Channel | Family |
|---|---|---|---|
| A | `ds/deepseek-v4-flash` | 9router gateway `http://127.0.0.1:20128/v1` | DeepSeek |
| B | `google/gemini-2.5-flash-lite` | OpenRouter API | Google |
| C | `cx/gpt-5.6-luna` | 9router gateway | OpenAI GPT |

- Three different model families; two provider endpoints (R5 satisfied: never
  the same call twice).
- A and C share the local gateway infrastructure but use different families
  and materially different prompts — documented as **Good+ tier** (not
  Preferred, which requires three independent providers).
- Judges never receive the production score, acceptance status, ending
  confidence, or rejection reason (R4). Input contract carries only
  pre/candidate/post transcript context + source evidence.

## 4. Judge input contract (Phase C)

```json
{
  "episode_id": "...", "candidate_id": "...", "language": "en",
  "pre_context":  {"start_sec": ..., "end_sec": ..., "text": "..."},
  "candidate":    {"start_sec": ..., "end_sec": ..., "duration_sec": ..., "text": "..."},
  "post_context": {"start_sec": ..., "end_sec": ..., "text": "..."},
  "source_evidence": {
    "speaker_turns": 0,
    "pause_features": {"pause_before_first_sec": ..., "pause_after_last_sec": ..., "speaker_change_after_end": false},
    "timing_precision": "cue"
  }
}
```

Pre/post context is ~30s of transcript around the window. All frozen-corpus
transcripts are cue-level (`timing_precision: "cue"`).

## 5. Rubric (Phase E)

start_complete, setup_sufficient, context_independence, hook_score (0-1),
topic_cohesion (0-1), payoff_score (0-1), ending_complete, next_topic_leakage,
hard_negative, standalone_score (0-1), publishable, confidence (0-1),
failure_reasons[], repair_hint{action,directional_seconds,semantic_reason},
short_reason. Validated with a Zod schema; parse failures are recorded as
`parse_failure` (R6), never converted into a content label.

## 6. Deterministic consensus (Phase F)

- A+B both publishable (confidence ≥ floor 0.5) and no critical veto → PASS
- A+B both non-publishable → FAIL
- A/B disagree on publishable → Judge C invoked
- After C: 2-of-3 publishable → PASS only if no majority critical veto;
  otherwise FAIL or REVIEW
- Critical rules: `hard_negative` or `next_topic_leakage` from a majority of
  judges → cannot PASS (AJ-06/AJ-07)
- Provider/parse failures → REVIEW with `INCOMPLETE_VOTES` (never fake labels)

## 7. Provider transport fixes (non-semantic)

- `src/lib/ai/providers/openai-compatible.ts`: strips a trailing
  `data: [DONE]` SSE marker emitted by the local 9router proxy even with
  `stream: false`; supports optional `extraBody` per request (used to send
  `thinking: {type: 'disabled'}` to the DeepSeek channel so hidden reasoning
  cannot starve the JSON output). Both changes are default-off and covered by
  the existing test suite (305 tests green).

## 8. Benchmark run

- Sample: 51 candidates, 10/10 episodes, seed 20260808 (manifest:
  `evidence/v12r/sample_manifest.json`)
- Results: **PASS 2, REVIEW 7, FAIL 42**; A/B agreement 80.4% (41/51);
  Judge C invoked 10× (19.6%); provider failures 0; parser failures 0.
- Raw judge outputs: `evidence/v12r/judge_outputs.jsonl`
- Consensus labels: `evidence/v12r/consensus_labels.jsonl`
- Metrics: `evidence/v12r/benchmark_metrics.json`

## 9. Sanity fixtures (Phase G/M)

AJ-01..AJ-20 implemented as 18 vitest tests in
`src/lib/v12r/__tests__/` (consensus matrix + H6/H1/sampling/contract
fixtures). All green; full suite 305 tests green.
