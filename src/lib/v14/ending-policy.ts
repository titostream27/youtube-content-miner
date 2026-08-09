/**
 * Brief V14 — Ending semantic policy (offline experiment seam).
 *
 * Implements the three-state ending model from §4 of the brief:
 *   COMPLETE   -> positive closing evidence; never hard-rejected on low
 *                 confidence alone; may receive a bounded soft penalty.
 *   INCOMPLETE -> affirmative evidence of truncation/unresolved syntax/
 *                 missing answer; evidence-backed hard reject permitted.
 *   UNKNOWN    -> insufficient/conflicting evidence; no hard reject merely
 *                 for uncertainty; bounded soft penalty or REVIEW path.
 *
 * The seam is a pure function: same inputs, same decision. Production code
 * never imports this module; only the offline V14 runner does.
 */
import type { EndingAnalysis, EndingType } from '@/lib/moments/topic-boundary';

/** Frozen production threshold (HIGHLIGHT_MIN_ENDING_CONFIDENCE default). */
export const ENDING_FLOOR = 0.82;

export type EndingState = 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';

export type EndingVariantId = 'C0' | 'E1' | 'E2' | 'E3' | 'E4';

/** Module-level source of truth for required reason codes (V14 §4). */
export const APPROVED_HARD_REJECT_CODES = [
  'ENDING_INCOMPLETE', // state INCOMPLETE (all families)
  'SYNTAX_TRUNCATION', // cut mid-word / dangling connective
  'PENDING_ANSWER', // ends on a question start
  'EMPTY_FILLER', // filler with no payoff
  'BOUNDARY_DEFECT', // explicit boundary defect evidence (contamination gate)
] as const;

export interface EndingPolicy {
  variant: EndingVariantId;
  /** Confidence floor for the confidence stage (0.82 production; 0.78 E1). */
  floor: number;
  /** E2: complete-class exemption below the floor. */
  completeExempt: boolean;
  /** E3/E4: evidence-backed hard reject only for observed invalidity. */
  evidenceHardReject: boolean;
  /** E3: bounded monotone soft penalty. */
  softPenaltyEnabled: boolean;
  /** Soft penalty cap in score points (grid 0/2/4/6; candidate default 4). */
  penaltyCap: number;
}

export interface EndingDecision {
  state: EndingState | null;
  action: 'PASS' | 'HARD_REJECT' | 'SOFT_PENALTY';
  reason_code: string | null;
  evidence_refs: string[];
  raw_confidence: number | null;
  hard_reject: boolean;
  observed_invalidity: boolean;
  soft_penalty: number;
  penalty_owner: string | null;
}

export const VARIANT_POLICIES: Record<EndingVariantId, EndingPolicy> = {
  C0: { variant: 'C0', floor: ENDING_FLOOR, completeExempt: false, evidenceHardReject: false, softPenaltyEnabled: false, penaltyCap: 0 },
  E1: { variant: 'E1', floor: 0.78, completeExempt: false, evidenceHardReject: false, softPenaltyEnabled: false, penaltyCap: 0 },
  E2: { variant: 'E2', floor: ENDING_FLOOR, completeExempt: true, evidenceHardReject: false, softPenaltyEnabled: false, penaltyCap: 0 },
  E3: { variant: 'E3', floor: ENDING_FLOOR, completeExempt: true, evidenceHardReject: true, softPenaltyEnabled: true, penaltyCap: 4 },
  E4: { variant: 'E4', floor: ENDING_FLOOR, completeExempt: true, evidenceHardReject: true, softPenaltyEnabled: false, penaltyCap: 0 },
};

/** Map a classifier EndingType to the V14 semantic state + evidence. */
export function endingEvidenceFor(endingType: EndingType): {
  state: EndingState;
  observed_invalidity: boolean;
  reason_code: string;
  evidence_label: string;
} {
  switch (endingType) {
    case 'ANSWER_COMPLETE':
    case 'CONCLUSION':
    case 'PUNCHLINE':
    case 'PAYOFF':
      return { state: 'COMPLETE', observed_invalidity: false, reason_code: 'COMPLETE_CLASS', evidence_label: 'complete closing evidence; no observed truncation' };
    case 'INCOMPLETE_SENTENCE':
      return { state: 'INCOMPLETE', observed_invalidity: true, reason_code: 'SYNTAX_TRUNCATION', evidence_label: 'syntactic truncation: dangling ending unit' };
    case 'QUESTION_START':
      return { state: 'INCOMPLETE', observed_invalidity: true, reason_code: 'PENDING_ANSWER', evidence_label: 'starts a question with no contained answer' };
    case 'FILLER':
      return { state: 'INCOMPLETE', observed_invalidity: true, reason_code: 'EMPTY_FILLER', evidence_label: 'filler utterance with no payoff' };
    case 'TOPIC_TRANSITION':
      return { state: 'UNKNOWN', observed_invalidity: false, reason_code: 'BOUNDARY_AMBIGUOUS', evidence_label: 'classifier disagrees on topic boundary; no affirmative truncation' };
    case 'UNKNOWN':
      return { state: 'UNKNOWN', observed_invalidity: false, reason_code: 'UNKNOWN_EVIDENCE', evidence_label: 'insufficient or conflicting evidence; never coerced to INCOMPLETE' };
  }
}

/** Bounded, monotone, deterministic soft penalty in score points. */
export function softPenalty(conf: number, state: EndingState, cap: number, floor: number = ENDING_FLOOR): number {
  if (conf >= floor) return 0;
  const slope = state === 'COMPLETE' ? 50 : 100; // UNKNOWN penalized more, but never like INCOMPLETE
  return Math.min(cap, Math.max(0, Math.round((floor - conf) * slope)));
}

/**
 * Pure decision for one ending analysis under one policy.
 * Monotonicity: for a fixed evidence payload, raising confidence never
 * changes PASS -> HARD_REJECT or increases (hard_reject, soft_penalty).
 */
export function decideEnding(ending: EndingAnalysis, policy: EndingPolicy): EndingDecision {
  const semantic = endingEvidenceFor(ending.endingType);
  const state = semantic.state;
  const conf = ending.endingConfidence;
  const evidence_refs = [
    `ending_type=${ending.endingType}`,
    `ending_confidence=${conf.toFixed(3)}`,
    `ending_complete=${ending.endingComplete}`,
  ];

  if (policy.evidenceHardReject) {
    // E3/E4: only affirmative evidence of invalidity can hard-reject.
    if (state === 'INCOMPLETE') {
      return {
        state,
        action: 'HARD_REJECT',
        reason_code: semantic.reason_code,
        evidence_refs,
        raw_confidence: conf,
        hard_reject: true,
        observed_invalidity: true,
        soft_penalty: 0,
        penalty_owner: null,
      };
    }
    const penalty = policy.softPenaltyEnabled ? softPenalty(conf, state, policy.penaltyCap, policy.floor) : 0;
    return {
      state,
      action: penalty > 0 ? 'SOFT_PENALTY' : 'PASS',
      reason_code: penalty > 0 ? 'ENDING_CONFIDENCE_LOW' : 'OK',
      evidence_refs,
      raw_confidence: conf,
      hard_reject: false,
      observed_invalidity: false,
      soft_penalty: penalty,
      penalty_owner: penalty > 0 ? 'ending_uncertainty' : null,
    };
  }

  // C0/E1/E2: production-like gating.
  if (!ending.endingComplete) {
    return {
      state,
      action: 'HARD_REJECT',
      reason_code: 'ENDING_INCOMPLETE',
      evidence_refs,
      raw_confidence: conf,
      hard_reject: true,
      observed_invalidity: true,
      soft_penalty: 0,
      penalty_owner: null,
    };
  }
  const exempt = policy.completeExempt && state === 'COMPLETE';
  if (!exempt && conf < policy.floor) {
    return {
      state,
      action: 'HARD_REJECT',
      reason_code: 'ENDING_CONFIDENCE_LOW',
      evidence_refs,
      raw_confidence: conf,
      hard_reject: true,
      observed_invalidity: false,
      soft_penalty: 0,
      penalty_owner: null,
    };
  }
  return {
    state,
    action: 'PASS',
    reason_code: 'OK',
    evidence_refs,
    raw_confidence: conf,
    hard_reject: false,
    observed_invalidity: false,
    soft_penalty: 0,
    penalty_owner: null,
  };
}

export const V14_ENDING_EVIDENCE_FAMILIES = [
  'syntactic truncation',
  'semantic dependency',
  'boundary defect',
  'low model confidence',
  'classifier disagreement',
] as const;