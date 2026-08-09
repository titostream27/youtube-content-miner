import type { EnrichedSentence } from '@/lib/moments/utterances';
import {
  classifyEnding,
  detectTopicBoundary,
  type EndingAnalysis,
  type TopicBoundary,
} from '@/lib/moments/topic-boundary';

/**
 * Phase 1 (Correctness) — Boundary repair (brief §12).
 *
 * When a candidate fails the quality gates, attempt repair in this order:
 *   1. Find the last conclusion before rough end.
 *   2. Cut before the next question.
 *   3. Extend if the answer is not finished yet.
 *   4. Re-run refinement with a larger context window (handled by caller —
 *      this module exposes `needsRefinementRetry`).
 *   5. Reject if no complete idea exists.
 *
 * Saved as structured state:
 *   {
 *     "boundary_status": "repaired",
 *     "original_start_sec": 120.0,
 *     "original_end_sec": 168.0,
 *     "final_start_sec": 124.3,
 *     "final_end_sec": 157.8,
 *     "repair_reason": "removed opening question of next topic"
 *   }
 */

export type BoundaryStatus = 'unrefined' | 'refined' | 'repaired' | 'rejected';

export interface BoundaryRepairRecord {
  boundaryStatus: BoundaryStatus;
  originalStartSec: number;
  originalEndSec: number;
  finalStartSec: number;
  finalEndSec: number;
  repairReason?: string;
  needsRefinementRetry?: boolean;
  /** Original full-transcript index of the selected ending anchor. */
  selectedEndingOriginalIndex?: number;
  /** Ending classification used for the selected anchor. */
  selectedEndingType?: EndingAnalysis['endingType'];
  /** Effective primary-search ceiling after applying the topic guard. */
  ceilingSec?: number;
  selectedEndingStartSec?: number;
  selectedEndingEndSec?: number;
}

export interface RepairCandidate {
  roughStartSec: number;
  roughEndSec: number;
}

/** Timestamp jitter tolerance; never use this as broad window expansion. */
const BOUNDARY_EPSILON_SEC = 0.05;

function validatedAcceptedResult(
  candidate: RepairCandidate,
  status: 'refined' | 'repaired',
  finalEndSec: number,
  repairReason: string,
  details: Pick<
    BoundaryRepairRecord,
    | 'needsRefinementRetry'
    | 'selectedEndingOriginalIndex'
    | 'selectedEndingType'
    | 'ceilingSec'
    | 'selectedEndingStartSec'
    | 'selectedEndingEndSec'
  > = {},
): BoundaryRepairRecord {
  const { roughStartSec, roughEndSec } = candidate;
  if (
    !Number.isFinite(roughStartSec) ||
    !Number.isFinite(finalEndSec) ||
    finalEndSec <= roughStartSec + BOUNDARY_EPSILON_SEC ||
    finalEndSec < roughStartSec - BOUNDARY_EPSILON_SEC
  ) {
    return {
      boundaryStatus: 'rejected',
      originalStartSec: roughStartSec,
      originalEndSec: roughEndSec,
      finalStartSec: roughStartSec,
      finalEndSec: roughEndSec,
      repairReason: 'invalid repaired range; rejecting',
    };
  }
  return {
    boundaryStatus: status,
    originalStartSec: roughStartSec,
    originalEndSec: roughEndSec,
    finalStartSec: roughStartSec,
    finalEndSec,
    repairReason,
    ...details,
  };
}

/**
 * Attempt to repair a failed boundary by snapping to the last acceptable
 * utterance end inside the rough window.
 *
 * @param utterances full utterance list
 * @param candidate the rough candidate that failed validation
 * @param preferEndBeforeSec soft ceiling (e.g. next topic start minus guard)
 * @returns a repair record. When nothing acceptable is found, the status is
 *          'rejected' and the caller should drop the candidate.
 */
export function repairBoundary(
  utterances: EnrichedSentence[],
  candidate: RepairCandidate,
  preferEndBeforeSec?: number,
): BoundaryRepairRecord {
  const { roughStartSec, roughEndSec } = candidate;
  if (
    !Number.isFinite(roughStartSec) ||
    !Number.isFinite(roughEndSec) ||
    (preferEndBeforeSec !== undefined && !Number.isFinite(preferEndBeforeSec))
  ) {
    return {
      boundaryStatus: 'rejected',
      originalStartSec: roughStartSec,
      originalEndSec: roughEndSec,
      finalStartSec: roughStartSec,
      finalEndSec: roughEndSec,
      repairReason: 'non-finite boundary timestamp; rejecting',
    };
  }
  if (roughEndSec <= roughStartSec) {
    return {
      boundaryStatus: 'rejected',
      originalStartSec: roughStartSec,
      originalEndSec: roughEndSec,
      finalStartSec: roughStartSec,
      finalEndSec: roughEndSec,
      repairReason: 'invalid rough range: end must be greater than start',
    };
  }
  // The primary ending search belongs to the rough candidate. A supplied
  // next-topic ceiling may shorten that window, but it must never enlarge it.
  const ceiling = Math.min(roughEndSec, preferEndBeforeSec ?? roughEndSec);
  const indexedUtterances = utterances.map((u, originalIndex) => ({ u, originalIndex }));

  // 1. Find ending anchors only inside the candidate-relevant window.
  // utterance overlapping roughStartSec may participate; one wholly before it
  // may not. Preserve original indexes for all later context lookup.
  const inside = indexedUtterances.filter(
      ({ u }) =>
        u.endSec > roughStartSec - BOUNDARY_EPSILON_SEC &&
        u.startSec < ceiling &&
        u.endSec <= ceiling + BOUNDARY_EPSILON_SEC,
    );
  if (inside.length === 0) {
    return {
      boundaryStatus: 'rejected',
      originalStartSec: roughStartSec,
      originalEndSec: roughEndSec,
      finalStartSec: roughStartSec,
      finalEndSec: roughEndSec,
      repairReason: 'no utterance inside the window; rejecting',
    };
  }

  // 2. Walk backwards from the last utterance to find the newest acceptable
  //    ending (complete, not a question start, not a topic transition).
  for (let i = inside.length - 1; i >= 0; i -= 1) {
    const { u: endU, originalIndex } = inside[i]!;
    const nextU = (originalIndex + 1 < utterances.length ? utterances[originalIndex + 1] : null) ?? null;
    const following = nextU ? utterances.slice(originalIndex + 1, originalIndex + 4) : [];

    const ending: EndingAnalysis = classifyEnding(endU, nextU, following);
    const boundary: TopicBoundary = nextU
      ? detectTopicBoundary(endU, nextU, following)
      : { nextTopicDetected: false, nextTopicStart: null, contamination: 0 };

    const acceptable =
      ending.endingComplete &&
      ending.endingType !== 'QUESTION_START' &&
      ending.endingType !== 'TOPIC_TRANSITION' &&
      (!boundary.nextTopicDetected || (boundary.nextTopicStart !== null && boundary.nextTopicStart > endU.endSec));

    if (acceptable) {
      const repaired = endU.endSec < roughEndSec - 0.5;
      return validatedAcceptedResult(
        candidate,
        repaired ? 'repaired' : 'refined',
        endU.endSec,
        repaired
          ? `truncated to last complete ending at ${endU.endSec.toFixed(1)}s (${ending.endingType})`
          : 'boundary already acceptable',
        {
          ceilingSec: ceiling,
          selectedEndingOriginalIndex: originalIndex,
          selectedEndingStartSec: endU.startSec,
          selectedEndingEndSec: endU.endSec,
          selectedEndingType: ending.endingType,
        },
      );
    }
  }

  // 3. Extend case: the answer is not finished. A preferEndBeforeSec below
  // the rough end is a next-topic guard and is authoritative: never extend
  // through it merely to satisfy duration/completeness.
  const extensionBudget = 8.0; // seconds beyond the rough end
  const extensionCeiling = Math.min(
    roughEndSec + extensionBudget,
    preferEndBeforeSec ?? Number.POSITIVE_INFINITY,
  );
  const startIdx = indexedUtterances.findIndex(({ u }) => u.endSec > roughEndSec);
  if (extensionCeiling > roughEndSec + BOUNDARY_EPSILON_SEC && startIdx >= 0) {
    const window = indexedUtterances.slice(startIdx, startIdx + 3);
    for (const { u: endU, originalIndex } of window) {
      if (endU.endSec > extensionCeiling + BOUNDARY_EPSILON_SEC) break;
      const nextU =
        (originalIndex + 1 < utterances.length ? utterances[originalIndex + 1] : null) ?? null;
      const following = nextU ? utterances.slice(originalIndex + 1, originalIndex + 4) : [];
      const ending = classifyEnding(endU, nextU, following);
      if (ending.endingComplete) {
        return validatedAcceptedResult(
          candidate,
          'repaired',
          endU.endSec,
          `extended to complete answer at ${endU.endSec.toFixed(1)}s`,
          {
            needsRefinementRetry: true,
            ceilingSec: extensionCeiling,
            selectedEndingOriginalIndex: originalIndex,
            selectedEndingStartSec: endU.startSec,
            selectedEndingEndSec: endU.endSec,
            selectedEndingType: ending.endingType,
          },
        );
      }
    }
  }

  return {
    boundaryStatus: 'rejected',
    originalStartSec: roughStartSec,
    originalEndSec: roughEndSec,
    finalStartSec: roughStartSec,
    finalEndSec: roughEndSec,
    repairReason: 'no complete idea found; rejecting',
  };
}
