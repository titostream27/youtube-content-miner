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
  timingPrecision?: 'word' | 'cue' | 'utterance';
  sliceApproximate?: boolean;
}

export interface FinalizeOutcome {
  segment: MomentSegment;
  startCheck: StartBoundaryResult;
  repairedStart: boolean;
}

export interface FinalizeOptions {
  candidateId: string;
  generationRunId: string;
  revision: number;
  boundarySource: 'rough' | 'semantic' | 'repair' | 'manual';
  parentCandidateId?: string;
}

/**
 * Brief v4 P0-B1/C5 (#18): ONE finalization path for semantic, repaired and
 * fallback candidates. Every candidate:
 *   1. validates its start boundary (hard gate — reject or expand start)
 *   2. slices the canonical transcript at word/cue precision
 *   3. recomputes ALL boundary-sensitive features from the FINAL slice
 *      (never inherits rough salience)
 *   4. stamps identity/lineage metadata.
 *
 * Returns the accepted segment or null when the candidate must be rejected.
 */
export function finalizeCandidate(
  rough: MomentSegment,
  utterances: EnrichedSentence[],
  slice: FinalizedSlice,
  opts: FinalizeOptions,
  candidateStartSec: number,
  candidateEndSec: number,
): FinalizeOutcome | null {
  // 1. Hard start gate: validate against PRECEDING context, not only inside.
  const startCheck = validateStartBoundary(utterances, candidateStartSec, candidateEndSec);
  let finalStartSec = candidateStartSec;
  let repairedStart = false;
  if (needsReject(startCheck)) {
    // Repair by expanding start back to a complete prior utterance, then
    // re-validate. If still hard-invalid, reject.
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

  // 2+3. Recompute metrics from the FINAL slice; never inherit rough values.
  const durationSec = Math.max(0.5, candidateEndSec - finalStartSec);
  const wordCount = slice.wordCount;
  const wordsPerSecond = Number((wordCount / durationSec).toFixed(3));
  const tokens = slice.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const unique = new Set(tokens).size;
  const lexicalSalience = tokens.length > 0 ? unique / tokens.length : 0;
  const salience = Number(Math.min(1, lexicalSalience + (slice.speakerTurns > 0 ? 0.05 : 0)).toFixed(3));

  const segment: MomentSegment = {
    ...rough,
    startSec: round(finalStartSec, 2),
    endSec: round(candidateEndSec, 2),
    durationSec: round(candidateEndSec - finalStartSec, 2),
    text: slice.text,
    wordCount,
    wordsPerSecond,
    salience,
    timingPrecision: slice.timingPrecision,
    sliceApproximate: slice.sliceApproximate,
    candidateId: opts.candidateId,
    generationRunId: opts.generationRunId,
    revision: opts.revision,
    parentCandidateId: opts.parentCandidateId,
    boundarySource: opts.boundarySource,
    scoringVersion: SCORING_VERSION,
  };
  return { segment, startCheck: repairedStart ? validateStartBoundary(utterances, finalStartSec, candidateEndSec) : startCheck, repairedStart };
}

const SCORING_VERSION = 'v4-finalize-1';

function round(n: number, p = 2): number {
  const m = 10 ** p;
  return Math.round(n * m) / m;
}

/**
 * Brief v4 P0-B1 (#18): recompute salience and derived scores from the FINAL
 * transcript slice (kept for callers that only need the rescore without the
 * full gate — e.g. tests).
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