import { config } from '@/lib/config';
import type { MomentSegment, Transcript } from '@/lib/domain/types';
import { cuesToUtterances, sliceTranscriptForRange, utteranceAtOrBefore, type Utterance } from '@/lib/moments/utterances';
import {
  classifyEnding,
  detectTopicBoundary,
  type EndingAnalysis,
  type TopicBoundary,
} from '@/lib/moments/topic-boundary';
import { repairBoundary } from '@/lib/moments/boundary-repair';
import { validateStartBoundary } from '@/lib/moments/start-boundary';
import { startBoundaryNeedsReject, expandStartBackToComplete } from '@/lib/moments/start-gate';
import { candidateFingerprint } from '@/lib/moments/candidate-identity';
import { finalizeCandidate } from '@/lib/moments/finalize-candidate';
import { refineBoundaries } from '@/lib/ai/agents/boundary-refinement-agent';
import { round } from '@/lib/scoring/normalize';
import type { AgentOverrides, UsageLedger } from '@/lib/ai';

/**
 * Hardening sprint Phase C: exact scoring configuration version stamped on
 * every emitted segment (lifecycle field). Bump when scoring weights / caps /
 * feature extraction change so offline evaluation can tell revisions apart.
 */
export const SCORING_VERSION = 'clip-score-v2';

/**
 * Phase 1 (Correctness) — Two-pass highlight selection.
 *
 * Pass 1: rough candidates from `detectMoments` (salience windows).
 * Pass 2: LLM boundary refinement on transcript context around each rough
 *   candidate (15s before rough_start, 20s after rough_end per the brief).
 *
 * After the agent returns final boundaries, deterministic guards enforce the
 * brief's hard rules (§7 Next-Topic Guard, §8 no forced duration, §9 ending
 * confidence, §10 start validation, §11 quality gates, §12 repair):
 *
 *   - final_end = min(selected_end, next_topic_start - end_guard)
 *   - repair when no complete ending found (snap to last conclusion)
 *   - reject when no complete idea exists even after repair
 *   - allow short complete clips down to minCompleteDurationSec
 *   - never exceed hardMaxSec
 */

export interface BoundaryDebugInfo {
  endingType: string;
  endingConfidence: number;
  nextTopicRemoved: boolean;
  nextTopicStartSec: number | null;
  nextTopicContamination: number;
  boundaryStatus?: string;
  repairReason?: string;
  roughStartSec?: number;
  roughEndSec?: number;
  boundaryConfidence?: number;
  startComplete?: boolean;
  mainTopic?: string;
  topicBefore?: string;
  topicAfter?: string;
}

export interface TwoPassResult {
  segments: MomentSegment[];
  utterances: Utterance[];
  warnings: string[];
  /** Phase 1 debug report per kept segment index (brief §13). */
  endingById: Map<number, BoundaryDebugInfo>;
}

interface BoundaryInfo {
  finalStartSec: number;
  finalEndSec: number;
  endingType: string;
  endingComplete: boolean;
  endingConfidence: number;
  nextTopicDetected: boolean;
  nextTopicStart: number | null;
  nextTopicContamination: number;
  reason: string;
}

/** Snap a boundary to the nearest utterance end within a small window. */
function snapToUtteranceEnd(
  utterances: Utterance[],
  targetSec: number,
  windowSec = 0.45,
): number {
  let bestSec = targetSec;
  let bestDist = Math.abs(utterances[0]!.startSec - targetSec);
  for (const u of utterances) {
    const dist = Math.abs(u.endSec - targetSec);
    if (dist <= windowSec && dist < bestDist) {
      bestDist = dist;
      bestSec = u.endSec;
    }
  }
  return bestSec;
}

/** Apply §7 next-topic guard: never cross into the next topic. */
function applyNextTopicGuard(
  selectedEnd: number,
  boundary: TopicBoundary,
  endGuardSec: number,
): { end: number; removedSec: number } {
  if (boundary.nextTopicDetected && boundary.nextTopicStart !== null) {
    const guarded = boundary.nextTopicStart - endGuardSec;
    if (guarded < selectedEnd) {
      return { end: Math.max(0, guarded), removedSec: selectedEnd - guarded };
    }
  }
  return { end: selectedEnd, removedSec: 0 };
}

/** Apply §8/§9/§10: duration bounds + ending confidence + contamination. */
function validateBoundary(
  startSec: number,
  endSec: number,
  ending: EndingAnalysis,
  boundary: TopicBoundary,
): { ok: boolean; reason?: string } {
  const h = config.pipeline.highlight;
  const duration = endSec - startSec;

  if (duration > h.hardMaxSec) {
    return { ok: false, reason: `exceeds hard max (${duration.toFixed(1)}s > ${h.hardMaxSec}s)` };
  }
  if (!ending.endingComplete) {
    return { ok: false, reason: `ending incomplete (${ending.endingType})` };
  }
  if (ending.endingConfidence < h.minEndingConfidence && duration >= h.preferredMinSec) {
    return { ok: false, reason: `ending confidence ${ending.endingConfidence.toFixed(2)} < ${h.minEndingConfidence}` };
  }
  if (boundary.contamination > h.maxNextTopicContamination) {
    return { ok: false, reason: `next-topic contamination ${boundary.contamination.toFixed(2)}` };
  }
  // Short-but-complete clips are allowed; anything shorter than the floor is not.
  if (duration < h.minCompleteDurationSec) {
    return { ok: false, reason: `too short (${duration.toFixed(1)}s < ${h.minCompleteDurationSec}s)` };
  }
  return { ok: true };
}

/**
 * Run the deterministic boundary computation for one rough candidate using the
 * utterance transcript (fallback when the LLM pass is unavailable).
 */
function deterministicBoundary(
  index: number,
  roughStartSec: number,
  roughEndSec: number,
  utterances: Utterance[],
): BoundaryInfo {
  const endIdx = utteranceAtOrBefore(utterances, roughEndSec);
  const startIdx = utteranceAtOrBefore(utterances, roughStartSec);

  const endUtterance = endIdx >= 0 ? utterances[endIdx]! : null;
  const nextUtterance = endIdx >= 0 && endIdx + 1 < utterances.length ? utterances[endIdx + 1]! : null;
  const following = endIdx >= 0 ? utterances.slice(endIdx + 1, endIdx + 4) : [];

  const ending = endUtterance
    ? classifyEnding(endUtterance, nextUtterance, following)
    : { endingType: 'CONCLUSION', endingConfidence: 0.5, endingComplete: true };
  const boundary = endUtterance
    ? detectTopicBoundary(endUtterance, nextUtterance, following, config.pipeline.highlight.nextTopicLookaheadSec)
    : { nextTopicDetected: false, nextTopicStart: null, contamination: 0 };

  const guard = applyNextTopicGuard(
    endUtterance?.endSec ?? roughEndSec,
    boundary,
    config.pipeline.highlight.endGuardSec,
  );
  const finalStart = startIdx >= 0 ? utterances[startIdx]!.startSec : roughStartSec;
  const finalEnd = snapToUtteranceEnd(utterances, guard.end, 0.45);

  return {
    finalStartSec: round(finalStart, 2),
    finalEndSec: round(finalEnd, 2),
    endingType: ending.endingType,
    endingComplete: ending.endingComplete,
    endingConfidence: round(ending.endingConfidence, 2),
    nextTopicDetected: boundary.nextTopicDetected,
    nextTopicStart: boundary.nextTopicStart !== null ? round(boundary.nextTopicStart, 2) : null,
    nextTopicContamination: round(boundary.contamination, 2),
    reason: 'deterministic boundary',
  };
}

export interface TwoPassOptions {
  minDurationSec: number;
  maxDurationSec: number;
  targetDurationSec: number;
  maxSegments: number;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
}

/**
 * Run two-pass highlight selection over a transcript.
 *
 * `roughSegments` come from Pass 1 (salience windows from detectMoments).
 * This function runs Pass 2 (boundary refinement) and applies the guards,
 * returning only segments that passed validation.
 */
export async function twoPassHighlightSelection(
  transcript: Transcript,
  roughSegments: MomentSegment[],
  episodeTitle: string,
  options: TwoPassOptions,
): Promise<TwoPassResult> {
  const warnings: string[] = [];
  const utterances = cuesToUtterances(transcript.cues);
  const endingById = new Map<number, BoundaryDebugInfo>();

  // Phase-2 correctness (Brief 2 Phase B): one stable generation run id per
  // call; every emitted segment carries it + a stable candidateId.
  const generationRunId = `gen-${transcript.videoId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Hardening v3 C6 (#19): candidate identity is a stable content/window
  // FINGERPRINT (survives rough-index shifts), not derived from the index.
  const candidateIdOf = (rough: MomentSegment): string => {
    const fp = candidateFingerprint(
      transcript.videoId,
      rough.startSec,
      rough.endSec,
      rough.text.split(/\s+/).slice(0, 4).join(' '),
      rough.text.split(/\s+/).slice(-4).join(' '),
    );
    return `c=${fp.slice(0, 12)}`;
  };

  if (roughSegments.length === 0) {
    return { segments: [], utterances, warnings, endingById };
  }

  // Pass 2 — LLM boundary refinement with context around each rough window.
  const refinement = await refineBoundaries({
    candidates: roughSegments.map((s) => ({
      index: s.index,
      roughStartSec: s.startSec,
      roughEndSec: s.endSec,
      roughText: s.text,
    })),
    utterances,
    episodeTitle,
    overrides: options.overrides,
    ledger: options.ledger,
    signal: options.signal,
  });
  warnings.push(...refinement.warnings);

  const infoById = new Map<number, BoundaryInfo>();
  for (const item of refinement.items) {
    infoById.set(item.index, {
      finalStartSec: item.finalStartSec,
      finalEndSec: item.finalEndSec,
      endingType: item.endingType,
      endingComplete: item.endingComplete,
      endingConfidence: item.endingConfidence,
      nextTopicDetected: item.nextTopicDetected,
      nextTopicStart: item.nextTopicStart,
      nextTopicContamination: item.nextTopicContamination,
      reason: item.reason,
    });
  }

  // Guard pass: enforce the brief's hard rules on every candidate.
  const segments: MomentSegment[] = [];
  let rejectedCount = 0;

  for (const rough of roughSegments) {
    const info = infoById.get(rough.index) ?? deterministicBoundary(
      rough.index,
      rough.startSec,
      rough.endSec,
      utterances,
    );

    // Re-run deterministic topic boundary on the agent's final end for the
    // guard (the agent may have moved the boundary).
    const endIdx = utteranceAtOrBefore(utterances, info.finalEndSec);
    const endUtterance = endIdx >= 0 ? utterances[endIdx]! : null;
    const nextUtterance = endIdx >= 0 && endIdx + 1 < utterances.length ? utterances[endIdx + 1]! : null;
    const following = endIdx >= 0 ? utterances.slice(endIdx + 1, endIdx + 4) : [];

    const ending = endUtterance
      ? classifyEnding(endUtterance, nextUtterance, following)
      : { endingType: 'CONCLUSION' as const, endingConfidence: 0.5, endingComplete: true };
    const boundary = endUtterance
      ? detectTopicBoundary(
          endUtterance,
          nextUtterance,
          following,
          config.pipeline.highlight.nextTopicLookaheadSec,
        )
      : { nextTopicDetected: false, nextTopicStart: null, contamination: 0 };

    // §7 next-topic guard on the final end.
    const guard = applyNextTopicGuard(
      info.finalEndSec,
      boundary,
      config.pipeline.highlight.endGuardSec,
    );
    let finalEnd = Math.min(info.finalEndSec, guard.end);
    let finalStart = Math.min(info.finalStartSec, finalEnd - 1);

    const validation = validateBoundary(finalStart, finalEnd, ending, boundary);
    if (!validation.ok) {
      // ── Phase 1 (brief §12): boundary repair before rejecting ──
      const repair = repairBoundary(
        utterances,
        { roughStartSec: rough.startSec, roughEndSec: rough.endSec },
        boundary.nextTopicStart !== null
          ? boundary.nextTopicStart - config.pipeline.highlight.endGuardSec
          : rough.endSec,
      );
      if (repair.boundaryStatus === 'repaired' || repair.boundaryStatus === 'refined') {
        const repEndIdx = utteranceAtOrBefore(utterances, repair.finalEndSec);
        const repEnd = repEndIdx >= 0 ? utterances[repEndIdx]! : null;
        const repNext = repEndIdx >= 0 && repEndIdx + 1 < utterances.length ? utterances[repEndIdx + 1]! : null;
        const repFollowing = repEndIdx >= 0 ? utterances.slice(repEndIdx + 1, repEndIdx + 4) : [];
        const repEnding = repEnd
          ? classifyEnding(repEnd, repNext, repFollowing)
          : { endingType: 'UNKNOWN' as const, endingConfidence: 0.3, endingComplete: false };
        const repBoundary = repEnd
          ? detectTopicBoundary(repEnd, repNext, repFollowing, config.pipeline.highlight.nextTopicLookaheadSec)
          : { nextTopicDetected: false, nextTopicStart: null, contamination: 0 };

        // Phase 2 (Start validation): explicit start-boundary checks replace
        // the assumed startComplete=true.
        const startCheck = validateStartBoundary(
          utterances,
          repair.finalStartSec,
          repair.finalEndSec,
        );

        // Phase-2 correctness (F12): the repaired boundary must pass the FULL
        // validation (duration, ending, contamination, floors) again — repair
        // previously pushed segments without re-validating.
        const repValidation = validateBoundary(
          repair.finalStartSec,
          repair.finalEndSec,
          repEnding,
          repBoundary,
        );
        if (!repValidation.ok) {
          rejectedCount += 1;
          warnings.push(`highlight ${rough.index}: repaired but still invalid — ${repValidation.reason}`);
          console.warn(`[two-pass] reject idx=${rough.index} after repair: ${repValidation.reason}`);
          continue;
        }
        endingById.set(rough.index, {
          endingType: repEnding.endingType,
          endingConfidence: round(repEnding.endingConfidence, 2),
          nextTopicRemoved: repBoundary.nextTopicDetected,
          nextTopicStartSec: repBoundary.nextTopicStart !== null ? round(repBoundary.nextTopicStart, 2) : null,
          nextTopicContamination: round(repBoundary.contamination, 2),
          boundaryStatus: repair.boundaryStatus,
          repairReason: repair.repairReason,
          roughStartSec: repair.originalStartSec,
          roughEndSec: repair.originalEndSec,
          boundaryConfidence: round(Math.max(repEnding.endingConfidence, 0.7), 2),
          startComplete: startCheck.startComplete,
        });
        // Phase 2 (Intelligence correctness): re-slice transcript text and
        // derived metrics from the FINAL repaired boundary — never reuse the
        // rough candidate's text/wordCount (they describe a different range).
        const finalSlice = sliceTranscriptForRange(
          utterances,
          repair.finalStartSec,
          repair.finalEndSec,
        );
        // Phase-2 correctness (F13): an empty transcript slice is a real
        // anomaly, not a reason to fall back to rough text (which described
        // a DIFFERENT window). Reject the repaired highlight instead.
        if (finalSlice.empty || finalSlice.wordCount === 0) {
          rejectedCount += 1;
          warnings.push(`highlight ${rough.index}: rejected — empty transcript after repair`);
          console.warn(`[two-pass] reject idx=${rough.index} after repair: empty transcript slice`);
          continue;
        }
        // Brief v4 P0-B1 (#6/#7): repaired candidates go through the SAME
        // finalization path — hard start gate (repair-or-reject), final-slice
        // rescoring, identity/lineage — never rough salience inheritance.
        const finalized = finalizeCandidate(
          rough,
          utterances,
          {
            text: finalSlice.text,
            wordCount: finalSlice.wordCount,
            wordsPerSecond: finalSlice.wordsPerSecond,
            speakerTurns: finalSlice.speakerTurns,
            timingPrecision: finalSlice.timingPrecision,
            sliceApproximate: finalSlice.sliceApproximate,
          },
          {
            candidateId: candidateIdOf(rough),
            generationRunId,
            revision: 2,
            boundarySource: 'repair',
            parentCandidateId: rough.candidateId || undefined,
          },
          repair.finalStartSec,
          repair.finalEndSec,
        );
        if (finalized === null) {
          rejectedCount += 1;
          warnings.push(`highlight ${rough.index}: repaired but start gate still rejects`);
          console.warn(`[two-pass] reject idx=${rough.index} after repair: start gate rejects`);
          continue;
        }
        segments.push(finalized.segment);
        warnings.push(`highlight ${rough.index}: ${repair.boundaryStatus} — ${repair.repairReason}`);
        console.warn(`[two-pass] repair idx=${rough.index}: ${repair.repairReason}`);
        continue;
      }
      rejectedCount += 1;
      warnings.push(`highlight ${rough.index}: rejected — ${validation.reason}`);
      console.warn(
        `[two-pass] reject idx=${rough.index} start=${finalStart.toFixed(1)} end=${finalEnd.toFixed(1)} ` +
          `dur=${(finalEnd - finalStart).toFixed(1)}s ending=${ending.endingType} ` +
          `conf=${ending.endingConfidence.toFixed(2)} contamination=${boundary.contamination.toFixed(2)} ` +
          `next_topic=${boundary.nextTopicDetected} reason=${validation.reason}`,
      );
      continue;
    }

    const duration = finalEnd - finalStart;
    // Phase 2 (Start validation): explicit start-boundary checks.
    // Phase C (P0.3): a hard start failure is repaired by pulling the start
    // back to a complete prior utterance, or the clip is rejected — never a
    // soft cap.
    const startCheck = validateStartBoundary(utterances, finalStart, finalEnd);
    if (startBoundaryNeedsReject(startCheck.issues)) {
      let repairedStart = finalStart;
      // Repair: expand start back to the last complete prior utterance.
      const expanded = expandStartBackToComplete(utterances, finalStart);
      if (expanded < finalStart - 0.05) {
        const repairedCheck = validateStartBoundary(utterances, expanded, finalEnd);
        if (!startBoundaryNeedsReject(repairedCheck.issues)) {
          repairedStart = expanded;
        }
      }
      if (repairedStart >= finalStart - 0.05) {
        rejectedCount += 1;
        warnings.push(`highlight ${rough.index}: rejected — start ${startCheck.primaryIssue ?? 'unresolved'} (${startCheck.issues.join(', ')})`);
        console.warn(`[two-pass] reject idx=${rough.index}: unresolved start boundary (${startCheck.issues.join(', ')})`);
        continue;
      }
      // Accepted repair: the start moved back; recompute the window.
      finalStart = repairedStart;
    }
    const startCompleteFinal = validateStartBoundary(utterances, finalStart, finalEnd);
    endingById.set(rough.index, {
      endingType: ending.endingType,
      endingConfidence: round(ending.endingConfidence, 2),
      nextTopicRemoved: boundary.nextTopicDetected,
      nextTopicStartSec: boundary.nextTopicStart !== null ? round(boundary.nextTopicStart, 2) : null,
      nextTopicContamination: round(boundary.contamination, 2),
      boundaryStatus: 'refined',
      repairReason: undefined,
      roughStartSec: rough.startSec,
      roughEndSec: rough.endSec,
      boundaryConfidence: round(ending.endingConfidence, 2),
      startComplete: startCompleteFinal.startComplete,
    });
    // Phase 2 (Intelligence correctness): the agent's final boundary may
    // differ from the rough window — re-slice text and metrics from the
    // actual final range so scoring/captions describe the rendered clip.
    const finalSlice = sliceTranscriptForRange(utterances, finalStart, finalEnd);
    // Phase-2 correctness (F13): never fall back to rough text (a different
    // window); an empty final slice is rejected as an anomaly.
    if (finalSlice.empty || finalSlice.wordCount === 0) {
      rejectedCount += 1;
      warnings.push(`highlight ${rough.index}: rejected — empty transcript slice`);
      console.warn(`[two-pass] reject idx=${rough.index}: empty transcript slice`);
      continue;
    }
    // Brief v4 P0-B1: the semantic path uses the SAME finalization gates as
    // the repaired path — start gate re-validated, final-slice rescoring,
    // identity/lineage. (finalizeCandidate re-checks the start; since the
    // start already passed above it will not re-expand.)
    const finalized = finalizeCandidate(
      rough,
      utterances,
      {
        text: finalSlice.text,
        wordCount: finalSlice.wordCount,
        wordsPerSecond: finalSlice.wordsPerSecond,
        speakerTurns: finalSlice.speakerTurns,
        timingPrecision: finalSlice.timingPrecision,
        sliceApproximate: finalSlice.sliceApproximate,
      },
      {
        candidateId: candidateIdOf(rough),
        generationRunId,
        revision: 1,
        boundarySource: 'semantic',
        parentCandidateId: rough.candidateId || undefined,
      },
      finalStart,
      finalEnd,
    );
    if (finalized === null) {
      rejectedCount += 1;
      warnings.push(`highlight ${rough.index}: finalize rejected (start gate)`);
      console.warn(`[two-pass] reject idx=${rough.index}: finalize start gate rejects`);
      continue;
    }
    segments.push(finalized.segment);
  }

  console.log(
    `[two-pass] episode "${episodeTitle}": ${roughSegments.length} rough -> ${segments.length} kept, ${rejectedCount} rejected`,
  );

  return { segments, utterances, warnings, endingById };
}
