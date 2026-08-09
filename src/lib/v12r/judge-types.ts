/**
 * Brief V12R — Automated silver-gold quality judge types and schema.
 *
 * Phase C/E contract: judges receive PRE/CANDIDATE/POST context and answer
 * with the rubric JSON from the brief. Nothing in this file references the
 * production selector's score, acceptance status, or rejection reason, so a
 * judge literally cannot read production signals (R4).
 */
import { z } from 'zod';

/** One judge's answer on a single candidate (brief Phase E schema). */
export const judgeOutputSchema = z.object({
  start_complete: z.boolean(),
  setup_sufficient: z.boolean(),
  context_independence: z.boolean(),
  hook_score: z.number().min(0).max(1),
  topic_cohesion: z.number().min(0).max(1),
  payoff_score: z.number().min(0).max(1),
  ending_complete: z.boolean(),
  next_topic_leakage: z.boolean(),
  hard_negative: z.boolean(),
  standalone_score: z.number().min(0).max(1),
  publishable: z.boolean(),
  confidence: z.number().min(0).max(1),
  failure_reasons: z.array(z.string()),
  repair_hint: z.object({
    action: z.enum(['NONE', 'EXPAND_START', 'TRIM_START', 'EXPAND_END', 'TRIM_END', 'REJECT']),
    directional_seconds: z.number(),
    semantic_reason: z.string(),
  }),
  short_reason: z.string(),
});

export type JudgeTier = 'A' | 'B' | 'C';

export interface JudgeVerdict {
  tier: JudgeTier;
  providerId: string;
  model: string;
  /** Validated rubric output. */
  output: z.infer<typeof judgeOutputSchema>;
}

export type JudgeOutcome =
  | { status: 'ok'; verdict: JudgeVerdict; attempts: number }
  | { status: 'provider_failure'; tier: JudgeTier; providerId: string; model: string; error: string; attempts: number }
  | { status: 'parse_failure'; tier: JudgeTier; providerId: string; model: string; raw: string; error: string; attempts: number };

export interface JudgeCall {
  tier: JudgeTier;
  providerId: string;
  model: string;
  /** Full raw model text (kept for evidence; may contain parse_able JSON). */
  raw_text: string;
  /** Validated output when the call succeeded. */
  output: z.infer<typeof judgeOutputSchema> | null;
  status: 'ok' | 'provider_error' | 'parse_failure';
  error: string | null;
  attempts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number;
}

export interface JudgeInputContract {
  episode_id: string;
  candidate_id: string;
  language: string;
  pre_context: { start_sec: number; end_sec: number; text: string };
  candidate: { start_sec: number; end_sec: number; duration_sec: number; text: string };
  post_context: { start_sec: number; end_sec: number; text: string };
  source_evidence: {
    speaker_turns: number;
    pause_features: {
      pause_before_first_sec: number;
      pause_after_last_sec: number;
      speaker_change_after_end: boolean;
    };
    timing_precision: 'word' | 'hybrid' | 'cue' | 'utterance';
  };
}

export type ConsensusLabel = 'PASS' | 'REVIEW' | 'FAIL';

export interface ConsensusDecision {
  label: ConsensusLabel;
  rule: string;
  /** Which judge verdicts were used (A/B/C), plus invalids. Null = missing vote. */
  votes: { tier: JudgeTier; publishable: boolean | null; critical_veto: boolean | null; confident: boolean }[];
  judge_c_invoked: boolean;
  /** Why, when the outcome is REVIEW. */
  reason: string;
}