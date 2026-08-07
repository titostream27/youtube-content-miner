import type { MomentSegment } from '@/lib/domain/types';
import type { EnrichedSentence, TranscriptSlice } from '@/lib/moments/utterances';
import { validateStartBoundary, type StartBoundaryResult } from '@/lib/moments/start-boundary';
import {
  startBoundaryNeedsReject,
  expandStartBackToComplete,
} from '@/lib/moments/start-gate';

function needsReject(check: StartBoundaryResult): boolean {
  return startBoundaryNeedsReject(check.issues ?? []);
}

export interface FinalizedSlice {
  text: string;
  wordCount: number;
  wordsPerSecond: number;
  speakerTurns: number;
  timingPrecision?: 'word' | 'hybrid' | 'cue' | 'utterance';
  sliceApproximate?: boolean;
  /** Brief v6 5.3: fraction of window covered by word timing. */
  wordTimingCoverage?: number;
  /** Brief v11 E2: canonical timing coverage alias. */
  timingCoverage?: number;
  uncoveredIntervalsSec?: { startSec: number; endSec: number }[];
  /** Brief v11 E2: text whose timing is uncertain or excluded. */
  excludedOrUncertainText?: string;
}

export interface FinalizeOutcome {
  segment: MomentSegment;
  startCheck: StartBoundaryResult;
  repairedStart: boolean;
  finalStartSec: number;
  finalEndSec: number;
}

export interface FinalizeOptions {
  candidateId: string;
  generationRunId: string;
  revision: number;
  boundarySource: 'rough' | 'semantic' | 'repair' | 'manual';
  parentCandidateId?: string;
}

/**
 * Brief v6 5.1/5.2 (M01) — full final-range validation inputs. After any
 * start repair, EVERY boundary-sensitive check must run against the FINAL
 * range, not the proposed range.
 */
export interface FinalRangeValidation {
  /** Hard maximum duration in seconds. Final duration above this rejects. */
  maxDurationSec?: number;
  /** Soft minimum duration. Final duration below this rejects. */
  minDurationSec?: number;
  /**
   * Validate ending/topic-boundary/contamination for a given range.
   * Returns null when the range is valid, else a reason string.
   */
  validateEndingAndContamination?: (startSec: number, endSec: number) => string | null;
  /**
   * Reject when the final range crosses a next-topic boundary that the
   * start repair introduced. Returns the boundary time or null when fine.
   */
  topicBoundaryAt?: (startSec: number, endSec: number) => number | null;
}

/**
 * Brief v5 Phase 2 (5.1): finalize boundaries FIRST, THEN slice the canonical
 * transcript for the FINAL range. This fixes M-01 (slice produced before
 * optional start repair) — the slice can no longer describe a different
 * window than segment.startSec/endSec.
 *
 * Contract:
 *   1. validate proposed end, duration, completeness, contamination (done by
 *      the caller's validateBoundary before this point).
 *   2. validate start boundary using preceding context.
 *   3. if a hard start issue is repairable, move start to the previous
 *      complete semantic unit.
 *   4. after any start change, re-run duration/end/contamination validation
 *      (the caller re-checks via validateBoundary on the final range).
 *   5. ONLY after timestamps are final, slice the canonical transcript for
 *      the final range (via sliceFn).
 *   6. reject when the final slice is empty.
 *   7. recompute text, word count, WPS, speaker turns, salience from the
 *      FINAL slice — never from rough values.
 *   8. build final debug metadata from THIS result only.
 */
export function finalizeCandidate(
  rough: MomentSegment,
  utterances: EnrichedSentence[],
  sliceFn: (startSec: number, endSec: number) => TranscriptSlice,
  opts: FinalizeOptions,
  candidateStartSec: number,
  candidateEndSec: number,
  finalValidation: FinalRangeValidation,
): FinalizeOutcome | null {
  // 2. Hard start gate against PRECEDING context.
  const startCheck = validateStartBoundary(utterances, candidateStartSec, candidateEndSec);
  let finalStartSec = candidateStartSec;
  let repairedStart = false;
  if (needsReject(startCheck)) {
    // 3. Repair: expand start back to a complete prior utterance.
    const expanded = expandStartBackToComplete(utterances, candidateStartSec);
    if (expanded !== null && expanded < candidateStartSec) {
      const recheck = validateStartBoundary(utterances, expanded, candidateEndSec);
      if (!needsReject(recheck)) {
        finalStartSec = expanded;
        repairedStart = true;
      }
    }
    const finalCheck = repairedStart
      ? validateStartBoundary(utterances, finalStartSec, candidateEndSec)
      : startCheck;
    if (needsReject(finalCheck)) {
      return null;
    }
  }
  const finalEndSec = candidateEndSec;

  // Brief v6 5.1/5.2 (M01): FULL final-range validation AFTER any start
  // repair — duration, ending/contamination, and next-topic boundaries must
  // be re-checked against the FINAL range before slicing. Brief v10 M03:
  // finalValidation is REQUIRED — production callers cannot omit it.
  const finalDuration = finalEndSec - finalStartSec;
  if (finalValidation.maxDurationSec !== undefined && finalDuration > finalValidation.maxDurationSec) {
    return null;
  }
  if (finalValidation.minDurationSec !== undefined && finalDuration < finalValidation.minDurationSec) {
    return null;
  }
  const topic = finalValidation.topicBoundaryAt?.(finalStartSec, finalEndSec);
  if (topic !== null && topic !== undefined) {
    return null;
  }
  const endingReason = finalValidation.validateEndingAndContamination?.(finalStartSec, finalEndSec);
  if (endingReason !== null && endingReason !== undefined) {
    return null;
  }

  // 5. Slice ONLY AFTER final timestamps are known (M-01 fix).
  const slice = sliceFn(finalStartSec, finalEndSec);
  // 6. Empty final slice -> reject; never recover from rough text.
  if (slice.empty || slice.wordCount === 0) {
    return null;
  }

  // 7. Recompute metrics from the FINAL slice.
  const durationSec = Math.max(0.5, finalEndSec - finalStartSec);
  const wordCount = slice.wordCount;
  const wordsPerSecond = Number((wordCount / durationSec).toFixed(3));
  const tokens = slice.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const unique = new Set(tokens).size;
  const lexicalSalience = tokens.length > 0 ? unique / tokens.length : 0;
  const salience = Number(Math.min(1, lexicalSalience + (slice.speakerTurns > 0 ? 0.05 : 0)).toFixed(3));

  const segment: MomentSegment = {
    ...rough,
    startSec: round(finalStartSec, 2),
    endSec: round(finalEndSec, 2),
    durationSec: round(finalEndSec - finalStartSec, 2),
    text: slice.text,
    wordCount,
    wordsPerSecond,
    salience,
    timingPrecision: slice.timingPrecision,
    sliceApproximate: slice.sliceApproximate,
    // Brief v6 5.3: carry coverage onto the final candidate.
    wordTimingCoverage: slice.wordTimingCoverage,
    timingCoverage: slice.timingCoverage,
    uncoveredIntervalsSec: slice.uncoveredIntervalsSec,
    excludedOrUncertainText: slice.excludedOrUncertainText,
    candidateId: opts.candidateId,
    generationRunId: opts.generationRunId,
    revision: opts.revision,
    parentCandidateId: opts.parentCandidateId,
    boundarySource: opts.boundarySource,
    scoringVersion: SCORING_VERSION,
  };
  return {
    segment,
    startCheck: repairedStart ? validateStartBoundary(utterances, finalStartSec, finalEndSec) : startCheck,
    repairedStart,
    finalStartSec,
    finalEndSec,
  };
}

export const SCORING_VERSION = 'v5-finalize-1';

function round(n: number, p = 2): number {
  const m = 10 ** p;
  return Math.round(n * m) / m;
}

/**
 * Recompose a FinalizedSlice view from a TranscriptSlice for callers that
 * need a plain object (kept for backwards compatibility).
 */
export function toFinalizedSlice(slice: TranscriptSlice): FinalizedSlice {
  return {
    text: slice.text,
    wordCount: slice.wordCount,
    wordsPerSecond: slice.wordsPerSecond,
    speakerTurns: slice.speakerTurns,
    timingPrecision: slice.timingPrecision,
    sliceApproximate: slice.sliceApproximate,
    wordTimingCoverage: slice.wordTimingCoverage,
    timingCoverage: slice.timingCoverage,
    uncoveredIntervalsSec: slice.uncoveredIntervalsSec,
    excludedOrUncertainText: slice.excludedOrUncertainText,
  };
}

/**
 * Legacy helper kept for tests/back-compat: recompute salience and derived
 * scores from a FINAL transcript slice without the full gate. New code should
 * use finalizeCandidate() (brief v5 5.1) which slices AFTER the start gate.
 */
export function rescoreSegmentFromSlice(
  rough: MomentSegment,
  slice: FinalizedSlice,
): MomentSegment {
  const durationSec = Math.max(0.5, rough.endSec - rough.startSec);
  const wordCount = slice.wordCount;
  const wordsPerSecond = Number((wordCount / durationSec).toFixed(3));
  const tokens = slice.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const unique = new Set(tokens).size;
  const lexicalSalience = tokens.length > 0 ? unique / tokens.length : 0;
  const baseSalience = Math.min(1, lexicalSalience + (slice.speakerTurns > 0 ? 0.05 : 0));
  return {
    ...rough,
    text: slice.text,
    wordCount,
    wordsPerSecond,
    salience: Number(baseSalience.toFixed(3)),
  };
}


/**
 * Brief v10 C02 (V10-M03): EXPLICIT test-only helper to build a permissive
 * FinalRangeValidation for unit tests. Production paths must supply a real
 * validator (finalRangeValidationFor); this helper exists so the production
 * parameter can stay REQUIRED without forcing every unit test to construct a
 * full boundary/ending pipeline.
 *
 * It accepts optional guards so tests can opt into rejecting specific ranges
 * (e.g. V10-MT01 hardMax). When omitted, everything passes.
 */
export function makePermissiveFinalValidationForTest(params?: {
  maxDurationSec?: number;
  minDurationSec?: number;
  topicBoundaryAt?: (startSec: number, endSec: number) => number | null;
  validateEndingAndContamination?: (startSec: number, endSec: number) => string | null;
}): import('@/lib/moments/finalize-candidate').FinalRangeValidation {
  return {
    maxDurationSec: params?.maxDurationSec,
    minDurationSec: params?.minDurationSec,
    topicBoundaryAt: params?.topicBoundaryAt ?? (() => null),
    validateEndingAndContamination: params?.validateEndingAndContamination ?? (() => null),
  };
}
