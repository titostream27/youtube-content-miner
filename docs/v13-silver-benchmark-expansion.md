# V13 Silver Benchmark Expansion (Phase C)

**Date:** 2026-08-09

## Strategy

Preferred strategy (§7): **full A/B consensus across all 344 V12 lineage
candidates**, with Judge C invoked on any A/B disagreement. The pool is
small enough (~344 windows) that full consensus is cost-acceptable, and a
full census eliminates the sample-selection questions of V12R. Previously
judged 51 candidates were re-consensus'd offline (Phase B) and their
persisted judge outputs are reused (resume) so no duplicate LLM spend.

## Judge configuration (CHANGED vs V12R — documented)

| Tier | V12R | V13 (this run) | Why |
|---|---|---|---|
| A | deepseek ds/deepseek-v4-flash (9router) | **unchanged** | works |
| B | openrouter google/gemini-2.5-flash-lite | **ag/gemini-3.5-flash-low via 9router** | the OpenRouter key in this environment carries **no credits** (verified `auth/key` → "never purchased credits", all 344 B calls in the first attempt returned provider_error); no other provider keys exist in the environment (GROQ/MISTRAL/XAI/TOGETHER/ANTHROPIC/GOOGLE all empty) |
| C | openai cx/gpt-5.6-luna (9router) | **unchanged** | works |

Independence tier: **Good** (three model families — DeepSeek, Google Gemini,
OpenAI GPT — through one gateway endpoint, materially different judge
prompts). V12R documented "Good+ (three families, two endpoints)"; the loss
of the OpenRouter endpoint downgrades the tier to Good. This is recorded in
`evidence/v13/benchmark_manifest.json` and the completion report (§24).

Judges remain independent of the production selector (R3): they read
PRE/CANDIDATE/POST windows only, never production scores or acceptance.

## Execution

- Manifest: `evidence/v13/benchmark_manifest.json` (344 candidates, 10 episodes, resume-ready).
- Judge run: `evidence/v13/judge_outputs.jsonl` (394-700 rows: A/B per candidate + C on disagreement; resume skips any candidate with A+B ok).
- Consensus: `evidence/v13/consensus_labels_v13.jsonl` (hardened v13.0 labels).
- Failure handling: raw judge calls persisted; provider/parse failures produce honest REVIEW labels (R6/R7), never fabricated content labels.

## Benchmark sufficiency gate (§5.1)

Target: **>=8 silver-PASS across >=4 distinct episodes** before any gate
tuning. If the final census produces fewer, the 344 pool is effectively
exhausted and the bottleneck is classified as candidate-generation/proposal
(or genuinely scarce publishable content), and downstream calibration
reverts to the documented stop-condition path.

## False-negative audit

Because the expansion runs the full A/B census, there is no A-screen
false-negative audit needed: every candidate receives both A and B, so any
candidate any judge would flag gets the full consensus treatment.