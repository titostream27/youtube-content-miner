import { config } from '@/lib/config';
import type { EndingType } from '@/lib/moments/topic-boundary';

/**
 * Phase 1 (Correctness) — Boundary quality gates (brief §11).
 *
 * Adds a structured BoundaryQuality dimension and HARD CAPS on the final
 * clip score. A clip that is incomplete, contaminated, or starts mid-sentence
 * is capped even if the LLM scored its content highly.
 *
 *   ending incomplete                        -> max score 74
 *   next-topic contamination too high        -> max score 76
 *   starts mid-sentence                      -> max score 80
 *   requires significant previous context    -> max score 82
 *   low boundary confidence                  -> cannot be Publish Immediately
 *
 * Publish Immediately additionally requires:
 *   endingComplete = true
 *   startComplete = true
 *   boundaryConfidence >= threshold
 *   nextTopicContamination <= threshold
 *   rights approved
 */

export interface BoundaryQuality {
  startComplete: boolean;
  endingComplete: boolean;
  endingType: EndingType;
  boundaryConfidence: number;
  previousTopicContamination: number;
  nextTopicContamination: number;
  nextTopicStartSec: number | null;
}

export interface BoundaryCapResult {
  /** The capped maximum this clip may receive. */
  maxScore: number;
  reasons: string[];
  /** True when the clip is eligible for Publish Immediately. */
  publishImmediatelyAllowed: boolean;
}

export const ENDING_INCOMPLETE_CAP = 74;
export const NEXT_TOPIC_CONTAMINATION_CAP = 76;
export const START_MID_SENTENCE_CAP = 80;
export const REQUIRES_PREVIOUS_CONTEXT_CAP = 82;

/**
 * Apply the boundary quality gates to a candidate clip score.
 *
 * @param rawScore the score from the quality/scoring engine (0-100)
 * @param quality the structured boundary quality for this candidate
 * @param requiresPreviousContext whether the clip needs significant earlier
 *        context to be understood (heuristic from the refinement agent)
 * @param rightsApproved whether the reuse rights have been approved
 */
export function applyBoundaryCaps(
  rawScore: number,
  quality: BoundaryQuality,
  opts: {
    requiresPreviousContext?: boolean;
    rightsApproved?: boolean;
  } = {},
): BoundaryCapResult {
  const h = config.pipeline.highlight;
  const reasons: string[] = [];
  let maxScore = 100;

  if (!quality.endingComplete) {
    maxScore = Math.min(maxScore, ENDING_INCOMPLETE_CAP);
    reasons.push(`ending incomplete (${quality.endingType}) -> cap ${ENDING_INCOMPLETE_CAP}`);
  }
  if (quality.nextTopicContamination > h.maxNextTopicContamination) {
    maxScore = Math.min(maxScore, NEXT_TOPIC_CONTAMINATION_CAP);
    reasons.push(
      `next-topic contamination ${quality.nextTopicContamination.toFixed(2)} > ${h.maxNextTopicContamination} -> cap ${NEXT_TOPIC_CONTAMINATION_CAP}`,
    );
  }
  if (!quality.startComplete) {
    maxScore = Math.min(maxScore, START_MID_SENTENCE_CAP);
    reasons.push(`starts mid-sentence -> cap ${START_MID_SENTENCE_CAP}`);
  }
  if (opts.requiresPreviousContext) {
    maxScore = Math.min(maxScore, REQUIRES_PREVIOUS_CONTEXT_CAP);
    reasons.push('requires significant previous context -> cap 82');
  }
  if (quality.boundaryConfidence < h.minBoundaryConfidence) {
    reasons.push(
      `low boundary confidence ${quality.boundaryConfidence.toFixed(2)} < ${h.minBoundaryConfidence}`,
    );
  }

  // Publish Immediately gating.
  const publishImmediatelyAllowed =
    quality.endingComplete &&
    quality.startComplete &&
    quality.boundaryConfidence >= h.minBoundaryConfidence &&
    quality.nextTopicContamination <= h.maxNextTopicContamination &&
    opts.rightsApproved !== false;

  return {
    maxScore: Math.max(0, Math.min(100, maxScore)),
    reasons,
    publishImmediatelyAllowed,
  };
}
