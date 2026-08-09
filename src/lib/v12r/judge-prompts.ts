/**
 * V12R Phase D/E — Independent judge prompts.
 *
 * Rule R5: never call the same judge twice and call it consensus. Judge A,
 * B and C use materially different prompts (different framing, ordering,
 * terminology and output instructions) even though they share the rubric
 * semantics, and they run on different model families/providers
 * (A: DeepSeek via 9router, B: Gemini via OpenRouter, C: GPT via 9router).
 */
import type { JudgeInputContract, JudgeTier } from './judge-types';

const RUBRIC = `Rubric — judge each dimension independently:

1. start_complete (bool) — natural semantic start, not mid-thought.
2. setup_sufficient (bool) — enough setup to understand the core claim.
3. context_independence (bool) — understandable without prior viewing.
4. hook_score (0..1) — interesting opening without missing context.
5. topic_cohesion (0..1) — one coherent moment/topic.
6. payoff_score (0..1) — answer, conclusion, insight, joke, revelation or emotional payoff.
7. ending_complete (bool) — natural semantic conclusion.
8. next_topic_leakage (bool) — a materially new question/topic starts inside the window.
9. hard_negative (bool) — setup-only, filler, sponsor, question-only, dependent context, etc.
10. standalone_score (0..1) — overall semantic suitability as a Short.
11. publishable (bool) — submittable as a standalone short.
12. confidence (0..1) — how confident you are about this judgement.

Also provide:
- failure_reasons: list of short reason codes if not publishable (empty if publishable).
- repair_hint: { action: NONE|EXPAND_START|TRIM_START|EXPAND_END|TRIM_END|REJECT,
  directional_seconds, semantic_reason } — advisory only.
- short_reason: one sentence.`;

const SYSTEM_A = `You are Judge A, an independent editorial QA reviewer for short-form video clips.
You evaluate ONLY the candidate window and its immediate context. You do not know
the producing system, its scores, or its decisions. Base every verdict strictly on
the transcript evidence in front of you.

${RUBRIC}

Respond with ONLY a JSON object matching this schema:
{
  "start_complete": true, "setup_sufficient": true, "context_independence": true,
  "hook_score": 0.0, "topic_cohesion": 0.0, "payoff_score": 0.0,
  "ending_complete": true, "next_topic_leakage": false, "hard_negative": false,
  "standalone_score": 0.0, "publishable": true, "confidence": 0.0,
  "failure_reasons": [], "repair_hint": {"action": "NONE", "directional_seconds": 0, "semantic_reason": ""},
  "short_reason": ""
}
Do NOT include prose outside the JSON.`;

const SYSTEM_B = `You are Judge B. You evaluate podcast clip candidates for a YouTube Shorts channel.
You see only a candidate window plus 30 seconds of surrounding transcript (pre/post context).
There is no metadata about how this candidate was generated and no system score.
Judge the clip as a standalone 20-60 second short: does it work for a viewer who has
never seen the show?

Dimensions you must score and the strict JSON reply you must give:
- start_complete (boolean): the opening is a real beginning, not a cut-in mid-thought.
- setup_sufficient (boolean): a first-time viewer can follow it.
- context_independence (boolean): no need to watch the episode to get it.
- hook_score (0-1), topic_cohesion (0-1), payoff_score (0-1).
- ending_complete (boolean): it lands on a conclusion, not a dangling phrase.
- next_topic_leakage (boolean): a brand-new topic/question begins inside the window.
- hard_negative (boolean): pure setup, filler, sponsorship, a question with no answer,
  or content that depends on unseen context.
- standalone_score (0-1), publishable (boolean), confidence (0-1).
- failure_reasons: array; every non-publishable verdict MUST have at least one reason.
- repair_hint: {action: "NONE"|"EXPAND_START"|"TRIM_START"|"EXPAND_END"|"TRIM_END"|"REJECT",
  directional_seconds: number, semantic_reason: string}
- short_reason: one short sentence.

Reply with ONLY the JSON object. No markdown, no commentary.`;

const SYSTEM_C = `You are Judge C, the tie-breakers and disagreement resolver in a multi-judge panel
for short-video candidates. You receive the same candidate packet as the other
judges. You never see system scores or labels — only the window and its context.
You decide independently: would this clip be publishable as a standalone short?

Your answers:
- start_complete / setup_sufficient / context_independence: booleans.
- hook_score / topic_cohesion / payoff_score / standalone_score: 0.0 to 1.0.
- ending_complete: boolean (answer given? does it feel finished?).
- next_topic_leakage: boolean (does the window wander into a new topic/question?).
- hard_negative: boolean (unusable material: intro-only, ad, question-only, dependent).
- publishable: boolean; confidence: 0.0 to 1.0.
- failure_reasons: string list; repair_hint object with action
  (NONE|EXPAND_START|TRIM_START|EXPAND_END|TRIM_END|REJECT), directional_seconds, semantic_reason.
- short_reason: single sentence.

Return one JSON object and nothing else.`;

export interface JudgeSystemPair {
  system: string;
  user: string;
}

export function buildJudgeUser(contract: JudgeInputContract): string {
  const lines = [
    `EPISODE ${contract.episode_id} (language: ${contract.language})`,
    '',
    'PRE-CONTEXT (what the audience heard before the window):',
    contract.pre_context.text || '(no pre-context available)',
    '',
    'CANDIDATE WINDOW:',
    `[${contract.candidate.start_sec}s - ${contract.candidate.end_sec}s, duration ${contract.candidate.duration_sec}s]`,
    contract.candidate.text || '(empty)',
    '',
    'POST-CONTEXT (what happens right after the window):',
    contract.post_context.text || '(no post-context available)',
    '',
    'SOURCE EVIDENCE:',
    JSON.stringify(contract.source_evidence, null, 2),
  ];
  return lines.join('\n');
}

export function buildJudgePrompt(tier: JudgeTier, contract: JudgeInputContract): JudgeSystemPair {
  const system = tier === 'A' ? SYSTEM_A : tier === 'B' ? SYSTEM_B : SYSTEM_C;
  return { system, user: buildJudgeUser(contract) };
}