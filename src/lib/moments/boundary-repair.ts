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
}

export interface RepairCandidate {
  roughStartSec: number;
  roughEndSec: number;
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
  const ceiling = preferEndBeforeSec ?? roughEndSec;

  // 1. Find the last utterance whose end is inside the ceiling.
  const inside = utterances.filter((u) => u.startSec < ceiling && u.endSec <= ceiling + 0.05);
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
    const endU = inside[i]!;
    const nextU = (i + 1 < utterances.length ? utterances[i + 1] : null) ?? null;
    const following = nextU ? utterances.slice(i + 1, i + 4) : [];

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
      return {
        boundaryStatus: repaired ? 'repaired' : 'refined',
        originalStartSec: roughStartSec,
        originalEndSec: roughEndSec,
        finalStartSec: Math.max(roughStartSec, endU.startSec),
        finalEndSec: endU.endSec,
        repairReason: repaired
          ? `truncated to last complete ending at ${endU.endSec.toFixed(1)}s (${ending.endingType})`
          : 'boundary already acceptable',
      };
    }
  }

  // 3. Extend case: the answer is not finished. Try the next few utterances
  //    beyond the ceiling (within a small extension budget).
  const extensionBudget = 8.0; // seconds beyond the rough end
  const startIdx = utterances.findIndex((u) => u.endSec > ceiling);
  if (startIdx >= 0) {
    const window = utterances.slice(startIdx, startIdx + 3);
    for (const endU of window) {
      if (endU.endSec > ceiling + extensionBudget) break;
      const idx = utterances.indexOf(endU);
      const nextU = (idx + 1 < utterances.length ? utterances[idx + 1] : null) ?? null;
      const following = nextU ? utterances.slice(idx + 1, idx + 4) : [];
      const ending = classifyEnding(endU, nextU, following);
      if (ending.endingComplete) {
        return {
          boundaryStatus: 'repaired',
          originalStartSec: roughStartSec,
          originalEndSec: roughEndSec,
          finalStartSec: Math.max(roughStartSec, endU.startSec),
          finalEndSec: endU.endSec,
          repairReason: `extended to complete answer at ${endU.endSec.toFixed(1)}s`,
          needsRefinementRetry: true,
        };
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
