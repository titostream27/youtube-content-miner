/**
 * Brief V13 Phase E — Production stage replay (TRACE).
 *
 * Replays an exact candidate window through the SAME production decision
 * functions and emits a stage-by-stage trace WITHOUT changing behavior.
 *
 * Production gate order (two-pass + finalizeCandidate):
 *   1. TEMPORAL_NORMALIZATION (deterministic boundary fallback)
 *   2. END-side gates FIRST (validateBoundary): duration hard max,
 *      ending complete (repair-before-reject), ending confidence,
 *      contamination, duration minimum
 *   3. START gate (finalizeCandidate): start validation + bounded repair
 *   4. scoring -> ranking -> acceptance threshold -> final accepted
 *
 * Emission: always all 14 canonical stages; status per stage is
 * SURVIVED | DIED | NOT_REACHED. Counterfactual bypass lets ONE stage be
 * bypassed while every other stage stays active.
 */
import { config } from '@/lib/config';
import type { MomentSegment, Transcript } from '@/lib/domain/types';
import {
  cuesToUtterances,
  sliceTranscriptForRange,
  utteranceAtOrBefore,
  type EnrichedSentence,
} from '@/lib/moments/utterances';
import {
  classifyEnding,
  detectTopicBoundary,
  type EndingAnalysis,
  type TopicBoundary,
} from '@/lib/moments/topic-boundary';
import { validateStartBoundary, type StartBoundaryResult } from '@/lib/moments/start-boundary';
import {
  startBoundaryNeedsReject,
  expandStartBackToComplete,
} from '@/lib/moments/start-gate';
import { repairBoundary } from '@/lib/moments/boundary-repair';
import { judgeSegmentHeuristically } from '@/lib/ai';
import { computeClipScore } from '@/lib/scoring/clip-score';
import { round } from '@/lib/scoring/normalize';
import { tierForScore } from '@/lib/domain/thresholds';
import type { LineageRow } from '@/lib/v12r/sampling';

export const TRACE_STAGES = [
  '00_LINEAGE_PRESENT',
  '01_PROPOSAL_VALID',
  '02_TEMPORAL_NORMALIZATION',
  '03_START_GATE',
  '04_ENDING_COMPLETE',
  '05_ENDING_CONFIDENCE',
  '06_CONTAMINATION_GATE',
  '07_DURATION_GATE',
  '08_DUPLICATE_OVERLAP',
  '09_COMPONENT_SCORING',
  '10_FINAL_SCORE',
  '11_RANKING',
  '12_ACCEPTANCE_THRESHOLD',
  '13_FINAL_ACCEPTED',
] as const;

export type StageName = (typeof TRACE_STAGES)[number];

export interface StageStep {
  stage: StageName;
  status: 'SURVIVED' | 'DIED' | 'NOT_REACHED';
  input: Record<string, unknown>;
  features: Record<string, unknown>;
  threshold: Record<string, unknown>;
  score: { before: number | null; after: number | null };
  reason_code: string | null;
  explanation: string;
}

export interface TraceResult {
  candidate_id: string;
  episode_id: string;
  window: { start_sec: number; end_sec: number };
  stages: StageStep[];
  first_death: StageName | null;
  first_death_reason: string | null;
  survived_to_scoring: boolean;
  final_accepted: boolean;
  final_score: number | null;
  original_rejection_stage: string | null;
  determinism_key: string;
}

export interface TraceOverrides {
  bypass?: ReadonlySet<StageName>;
  altEndingConfidence?: number;
  altMaxContamination?: number;
  altMinCompleteDuration?: number;
  altHardMaxSec?: number;
  altClipScoreThreshold?: number;
}

/** Utterances within a time window starting after endIdx. */
function followingWithinLookaheadSec(
  utterances: EnrichedSentence[],
  endIdx: number,
  endSec: number,
  lookaheadSec: number,
): EnrichedSentence[] {
  if (endIdx < 0 || endIdx >= utterances.length) return [];
  const horizon = endSec + lookaheadSec;
  const out: EnrichedSentence[] = [];
  for (let i = endIdx + 1; i < utterances.length; i++) {
    const u = utterances[i];
    if (!u) break;
    if (u.startSec > horizon) break;
    out.push(u);
  }
  return out;
}

/** Production next-topic guard (§7). */
function applyNextTopicGuard(selectedEnd: number, boundary: TopicBoundary, endGuardSec: number): number {
  if (boundary.nextTopicDetected && boundary.nextTopicStart !== null) {
    const guarded = boundary.nextTopicStart - endGuardSec;
    if (guarded < selectedEnd) return Math.max(0, guarded);
  }
  return selectedEnd;
}

/** Snap to nearest utterance end within a small window. */
function snapToUtteranceEnd(utterances: EnrichedSentence[], targetSec: number, windowSec = 0.45): number {
  let bestSec = targetSec;
  let bestDist = Math.abs((utterances[0]?.endSec ?? targetSec) - targetSec);
  for (const u of utterances) {
    const dist = Math.abs(u.endSec - targetSec);
    if (dist <= windowSec && dist < bestDist) {
      bestDist = dist;
      bestSec = u.endSec;
    }
  }
  return bestSec;
}

/**
 * Deterministic boundary normalization — the two-pass fallback used by the
 * production runs whose engine was "heuristic".
 */
function deterministicNormalization(
  utterances: EnrichedSentence[],
  roughStartSec: number,
  roughEndSec: number,
  nextTopicLookaheadSec: number,
  endGuardSec: number,
): { startSec: number; endSec: number } {
  const startIdx = utteranceAtOrBefore(utterances, roughStartSec);
  const endIdxLocal = utteranceAtOrBefore(utterances, roughEndSec);
  let finalEnd = roughEndSec;
  if (endIdxLocal >= 0) {
    const endU = utterances[endIdxLocal]!;
    const nxt = endIdxLocal + 1 < utterances.length ? utterances[endIdxLocal + 1]! : null;
    const following = followingWithinLookaheadSec(utterances, endIdxLocal, endU.endSec, nextTopicLookaheadSec);
    const boundary = nxt
      ? detectTopicBoundary(endU, nxt, following, nextTopicLookaheadSec)
      : { nextTopicDetected: false, nextTopicStart: null, contamination: 0 };
    finalEnd = applyNextTopicGuard(endU.endSec ?? roughEndSec, boundary, endGuardSec);
    finalEnd = snapToUtteranceEnd(utterances, finalEnd, 0.45);
  }
  const finalStart = startIdx >= 0 ? (utterances[startIdx]?.startSec ?? roughStartSec) : roughStartSec;
  return { startSec: finalStart, endSec: finalEnd };
}

/** Ending + topic-boundary evidence computed at an end second. */
function evidenceAt(
  utterances: EnrichedSentence[],
  endSec: number,
  lookaheadSec: number,
): { ending: EndingAnalysis; boundary: TopicBoundary } {
  const endIdx = utteranceAtOrBefore(utterances, endSec);
  if (endIdx < 0) {
    return {
      ending: { endingType: 'UNKNOWN', endingConfidence: 0.45, endingComplete: false },
      boundary: { nextTopicDetected: false, nextTopicStart: null, contamination: 0 },
    };
  }
  const endU = utterances[endIdx]!;
  const nxt = endIdx + 1 < utterances.length ? utterances[endIdx + 1]! : null;
  const following = followingWithinLookaheadSec(utterances, endIdx, endU.endSec, lookaheadSec);
  return {
    ending: classifyEnding(endU, nxt, following),
    boundary: nxt
      ? detectTopicBoundary(endU, nxt, following, lookaheadSec)
      : { nextTopicDetected: false, nextTopicStart: null, contamination: 0 },
  };
}

export function traceCandidate(
  lineageRow: LineageRow,
  transcript: Transcript,
  opts: { overrides?: TraceOverrides } = {},
): TraceResult {
  const overrides = opts.overrides ?? {};
  const h = config.pipeline.highlight;
  const clipThreshold = overrides.altClipScoreThreshold ?? config.pipeline.clipScoreThreshold;

  const candidateId = lineageRow.candidate_id ?? 'unknown';
  const episodeId = lineageRow.episode_id ?? 'unknown';
  const roughStart = lineageRow.rough_start_sec ?? 0;
  const roughEnd = lineageRow.rough_end_sec ?? 0;
  const finalStartRaw = lineageRow.final_start_sec ?? null;
  const finalEndRaw = lineageRow.final_end_sec ?? null;
  const utterances = cuesToUtterances(transcript.cues) as EnrichedSentence[];

  const steps: StageStep[] = [];
  let firstDeath: StageName | null = null;
  let firstDeathReason: string | null = null;

  const record = (step: StageStep): void => {
    steps.push(step);
    if (step.status === 'DIED' && firstDeath === null) {
      firstDeath = step.stage;
      firstDeathReason = step.explanation;
    }
  };
  const die = (stage: StageName, reason: string, code: string, extra: Partial<StageStep> = {}): void => {
    record({ stage, status: 'DIED', input: {}, features: {}, threshold: {}, score: { before: null, after: null }, reason_code: code, explanation: reason, ...extra });
  };
  const survive = (stage: StageName, extra: Partial<StageStep> = {}): void => {
    record({ stage, status: 'SURVIVED', input: {}, features: {}, threshold: {}, score: { before: null, after: null }, reason_code: 'OK', explanation: `${stage} passed`, ...extra });
  };
  const bypassing = (stage: StageName): boolean =>
    overrides.bypass !== undefined && overrides.bypass.has(stage);

  const finalize = (): TraceResult => {
      // Fill every canonical stage first, then canonicalize order with ONE
      // entry per stage (production evaluates end-side gates before the
      // start gate; traces never duplicate a stage).
      const recorded = new Set(steps.map((s) => s.stage));
      for (const stage of TRACE_STAGES) {
        if (recorded.has(stage)) continue;
        steps.push({
          stage,
          status: 'NOT_REACHED',
          input: {},
          features: {},
          threshold: {},
          score: { before: null, after: null },
          reason_code: 'NOT_REACHED',
          explanation: firstDeath ? `not reached (first death at ${firstDeath})` : 'not reached',
        });
      }
      const orderOf = new Map(TRACE_STAGES.map((s, i) => [s, i]));
      const seen = new Set<StageName>();
      const deduped = steps.filter((s) => {
        if (seen.has(s.stage)) return false;
        seen.add(s.stage);
        return true;
      });
      deduped.sort((a, b) => (orderOf.get(a.stage) ?? 99) - (orderOf.get(b.stage) ?? 99));
      steps.length = 0;
      steps.push(...deduped);
    const scoreStep = steps.find((s) => s.stage === '10_FINAL_SCORE');
    const acceptedStep = steps.find((s) => s.stage === '13_FINAL_ACCEPTED');
    return {
      candidate_id: candidateId,
      episode_id: episodeId,
      window: { start_sec: finalStart, end_sec: finalEnd },
      stages: steps,
      first_death: firstDeath,
      first_death_reason: firstDeathReason,
      survived_to_scoring: steps.some((s) => s.stage === '09_COMPONENT_SCORING' && s.status === 'SURVIVED'),
      final_accepted: acceptedStep !== undefined && acceptedStep.status === 'SURVIVED',
      final_score: scoreStep && scoreStep.status === 'SURVIVED' ? (scoreStep.score.after as number | null) : null,
      original_rejection_stage: lineageRow.rejection_stage ?? null,
      determinism_key: `${candidateId}:${roughStart}:${roughEnd}:${finalStartRaw}:${finalEndRaw}`,
    };
  };

  let finalStart = finalStartRaw ?? roughStart;
  let finalEnd = finalEndRaw ?? roughEnd;

  // 00 LINEAGE_PRESENT
  if (!lineageRow.candidate_id) {
    die('00_LINEAGE_PRESENT', 'candidate not present in lineage', 'NO_LINEAGE_ROW');
    return finalize();
  }
  survive('00_LINEAGE_PRESENT', { input: { candidate_id: candidateId, episode_id: episodeId } });

  // 01 PROPOSAL_VALID
  const proposalValid = Number.isFinite(roughStart) && Number.isFinite(roughEnd) && roughEnd > roughStart;
  if (!proposalValid) {
    die('01_PROPOSAL_VALID', `invalid proposal range (${roughStart}-${roughEnd})`, 'INVALID_PROPOSAL', {
      input: { rough_start_sec: roughStart, rough_end_sec: roughEnd },
    });
    if (!bypassing('01_PROPOSAL_VALID')) return finalize();
    survive('01_PROPOSAL_VALID', { features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
  } else {
    survive('01_PROPOSAL_VALID', {
      input: { rough_start_sec: roughStart, rough_end_sec: roughEnd, rough_duration_sec: round(roughEnd - roughStart, 2) },
    });
  }

  // 02 TEMPORAL_NORMALIZATION
  let normalizedFromRough = false;
  if (finalStartRaw !== null && finalEndRaw !== null) {
    finalStart = finalStartRaw;
    finalEnd = finalEndRaw;
  } else {
    const norm = deterministicNormalization(utterances, roughStart, roughEnd, h.nextTopicLookaheadSec, h.endGuardSec);
    finalStart = norm.startSec;
    finalEnd = norm.endSec;
    normalizedFromRough = true;
  }
  const temporalValid = Number.isFinite(finalStart) && Number.isFinite(finalEnd) && finalEnd >= finalStart;
  if (!temporalValid) {
    die('02_TEMPORAL_NORMALIZATION', `negative/zero duration or non-finite final range (${finalStart}-${finalEnd})`, 'TEMPORAL_INVALID', {
      input: { final_start_sec: finalStart, final_end_sec: finalEnd },
      threshold: { invariant: 'final_end >= final_start; both finite' },
    });
    if (!bypassing('02_TEMPORAL_NORMALIZATION')) return finalize();
    survive('02_TEMPORAL_NORMALIZATION', { features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
  } else {
    survive('02_TEMPORAL_NORMALIZATION', {
      input: { final_start_sec: finalStart, final_end_sec: finalEnd },
      features: {
        final_duration_sec: round(finalEnd - finalStart, 2),
        normalized_from_deterministic_boundary: normalizedFromRough,
      },
      threshold: {
        invariant: 'final_end >= final_start; both finite',
        method: normalizedFromRough ? 'deterministicBoundary (two-pass fallback)' : 'lineage final timestamps',
      },
    });
  }

  const finalDuration = (): number => finalEnd - finalStart;
  const hardMax = overrides.altHardMaxSec ?? h.hardMaxSec;
  const minDur = overrides.altMinCompleteDuration ?? h.minCompleteDurationSec;

  // ── END-side gates FIRST (production validateBoundary order) ──
    // Production calls repairBoundary ONCE on ANY validateBoundary failure
        // (duration, ending completeness, confidence, contamination, min duration),
        // then re-validates the repaired window; only a still-failing window is
        // rejected. The trace mirrors that: one repair attempt, then the failure
        // is attributed to the first stage that still fails (production order).
        let ev = evidenceAt(utterances, finalEnd, h.nextTopicLookaheadSec);
        const minEndingConf = overrides.altEndingConfidence ?? h.minEndingConfidence;
        const maxContamination = overrides.altMaxContamination ?? h.maxNextTopicContamination;

    const failingStage = (): StageName | null => {
      if (finalDuration() > hardMax) return '07_DURATION_GATE';
      if (!ev.ending.endingComplete) return '04_ENDING_COMPLETE';
      if (ev.ending.endingConfidence < minEndingConf && finalDuration() >= h.preferredMinSec) return '05_ENDING_CONFIDENCE';
      if (ev.boundary.contamination > maxContamination) return '06_CONTAMINATION_GATE';
      if (finalDuration() < minDur) return '07_DURATION_GATE';
      return null;
    };

    let firstFail = failingStage();
        let repairedEnd = false;
        if (firstFail !== null) {
          const preferEnd = ev.boundary.nextTopicStart !== null
            ? ev.boundary.nextTopicStart - h.endGuardSec
            : roughEnd;
          // Production repairBoundary is called with the ROUGH window (two-pass
          // §12) and its finalStartSec/finalEndSec become the new boundaries.
          const repair = repairBoundary(utterances, { roughStartSec: roughStart, roughEndSec: roughEnd }, preferEnd);
          if (repair.boundaryStatus === 'repaired' || repair.boundaryStatus === 'refined') {
            finalStart = repair.finalStartSec;
            finalEnd = repair.finalEndSec;
            ev = evidenceAt(utterances, finalEnd, h.nextTopicLookaheadSec);
            repairedEnd = true;
            firstFail = failingStage();
          }
        }

    if (firstFail !== null) {
          if (!bypassing(firstFail)) {
            const reasonMap: Record<string, string> = {
              '04_ENDING_COMPLETE': `ending incomplete (${ev.ending.endingType})`,
              '05_ENDING_CONFIDENCE': `ending confidence ${ev.ending.endingConfidence.toFixed(2)} < ${minEndingConf}`,
              '06_CONTAMINATION_GATE': `next-topic contamination ${ev.boundary.contamination.toFixed(2)} > ${maxContamination}`,
              '07_DURATION_GATE': finalDuration() > hardMax ? `exceeds hard max (${round(finalDuration(), 1)}s > ${hardMax}s)` : `too short (${round(finalDuration(), 1)}s < ${minDur}s)`,
            };
            const failInfo = firstFail === '04_ENDING_COMPLETE'
              ? { features: { ending_type: ev.ending.endingType, ending_confidence: ev.ending.endingConfidence, repair_attempted: true, repaired_end: repairedEnd } }
              : firstFail === '05_ENDING_CONFIDENCE'
                ? { features: { ending_confidence: ev.ending.endingConfidence, duration_sec: round(finalDuration(), 2), repair_attempted: true, repaired_end: repairedEnd }, threshold: { min: minEndingConf } }
                : firstFail === '06_CONTAMINATION_GATE'
                  ? { features: { contamination: ev.boundary.contamination, next_topic_detected: ev.boundary.nextTopicDetected, repair_attempted: true, repaired_end: repairedEnd }, threshold: { max: maxContamination } }
                  : { features: { duration_sec: round(finalDuration(), 2), repair_attempted: true, repaired_end: repairedEnd }, threshold: { min: minDur } };
            const code = firstFail === '04_ENDING_COMPLETE' ? 'ENDING_INCOMPLETE'
              : firstFail === '05_ENDING_CONFIDENCE' ? 'ENDING_CONFIDENCE_LOW'
                : firstFail === '06_CONTAMINATION_GATE' ? 'NEXT_TOPIC_CONTAMINATION'
                  : firstFail === '07_DURATION_GATE' ? (finalDuration() > hardMax ? 'DURATION_HARD_MAX' : 'DURATION_MIN') : 'UNKNOWN';
            die(firstFail,
              `${reasonMap[firstFail]}${repairedEnd ? ' (after repair attempt)' : ''}`,
              code,
              failInfo,
            );
            return finalize();
          }
          // Counterfactual bypass: failing stage recorded as survived-bypassed,
          // all downstream stages stay active with the current evidence.
          survive(firstFail, {
            features: { bypassed: true, failed_condition: firstFail, ending_confidence: ev.ending.endingConfidence },
            explanation: `bypassed (counterfactual): ${firstFail}`,
          });
        }

    // Record SURVIVED for the end-side stages, with repair evidence.
    if (repairedEnd) {
      survive('04_ENDING_COMPLETE', {
        input: { end_sec: finalEnd },
        features: { ending_type: ev.ending.endingType, ending_complete: true, ending_confidence: ev.ending.endingConfidence, repaired_to: round(finalEnd, 2) },
        threshold: { rule: 'repair before reject' },
        explanation: 'ending repaired to a complete boundary',
      });
    } else {
      survive('04_ENDING_COMPLETE', {
        input: { end_sec: finalEnd },
        features: { ending_type: ev.ending.endingType, ending_complete: true, ending_confidence: ev.ending.endingConfidence },
      });
    }
    survive('05_ENDING_CONFIDENCE', {
      input: { end_sec: finalEnd },
      features: { ending_confidence: ev.ending.endingConfidence, duration_sec: round(finalDuration(), 2) },
      threshold: { min: minEndingConf, preferred_min_sec: h.preferredMinSec },
    });
    survive('06_CONTAMINATION_GATE', {
      input: { end_sec: finalEnd },
      features: { contamination: ev.boundary.contamination, next_topic_detected: ev.boundary.nextTopicDetected },
      threshold: { max: maxContamination },
    });
    survive('07_DURATION_GATE', {
      input: { start_sec: finalStart, end_sec: finalEnd },
      features: { duration_sec: round(finalDuration(), 2), repaired_end: repairedEnd, window_after_repair: finalDuration() > hardMax ? 'too long' : finalDuration() < minDur ? 'too short' : 'ok' },
      threshold: { min: minDur, hard_max: hardMax, preferred: [h.preferredMinSec, h.preferredMaxSec] },
    });

  // ── START gate (finalizeCandidate path) after the end gates ──
  let startCheck: StartBoundaryResult = validateStartBoundary(utterances, finalStart, finalEnd);
  let repairedStart: number | null = null;
  const hard = startBoundaryNeedsReject(startCheck.issues ?? []);
  if (hard) {
    const expanded = expandStartBackToComplete(utterances, finalStart);
    if (expanded !== null && expanded < finalStart) {
      const recheck = validateStartBoundary(utterances, expanded, finalEnd);
      if (!startBoundaryNeedsReject(recheck.issues ?? [])) {
        repairedStart = expanded;
        startCheck = recheck;
      }
    }
  }
  const stillHard = hard && repairedStart === null;
    if (stillHard) {
      if (!bypassing('03_START_GATE')) {
        die('03_START_GATE', `start gate hard failure: ${(startCheck.issues ?? []).join(',')} (no valid repair)`, 'START_GATE_HARD', {
          input: { start_sec: finalStart, end_sec: finalEnd },
          features: { issues: startCheck.issues ?? [], start_complete: startCheck.startComplete, hook_delay_sec: startCheck.hookDelaySec },
        });
        return finalize();
      }
      survive('03_START_GATE', { features: { issues: startCheck.issues ?? [], bypassed: true }, explanation: 'bypassed (counterfactual)' });
    } else {
    if (repairedStart !== null) finalStart = repairedStart;
    survive('03_START_GATE', {
      input: { start_sec: finalStart, end_sec: finalEnd },
      features: {
        issues: startCheck.issues ?? [],
        start_complete: startCheck.startComplete,
        start_repaired_to: repairedStart,
        start_repair_used: repairedStart !== null,
      },
      explanation: repairedStart !== null ? 'start repaired to complete prior unit' : 'start boundary complete',
    });
  }

  // 08 DUPLICATE / OVERLAP — greedy non-overlap at proposal time; herd
  // analysis in scripts/v13-tracer.ts.
  survive('08_DUPLICATE_OVERLAP', {
    features: { note: 'overlap resolution applied at proposal time; herd analysis in tracer script' },
  });

  // 09 COMPONENT_SCORING — real heuristic scoring path (deterministic).
  const slice = sliceTranscriptForRange(utterances, finalStart, finalEnd);
  const seg: MomentSegment = {
    index: 0,
    startSec: finalStart,
    endSec: finalEnd,
    durationSec: finalEnd - finalStart,
    text: slice.text,
    wordCount: slice.wordCount,
    wordsPerSecond: slice.wordsPerSecond,
    salience: 0.5,
    candidateId,
    generationRunId: 'trace-v13',
    revision: 0,
  };
  const judgement = judgeSegmentHeuristically(seg);
  const score = computeClipScore(judgement.dimensions, { durationSec: finalEnd - finalStart });
  survive('09_COMPONENT_SCORING', {
    input: { window: [finalStart, finalEnd], text_preview: slice.text.slice(0, 120) },
    features: { scoring_engine: 'heuristic', dimensions: judgement.dimensions },
  });

  // 10 FINAL_SCORE
  const finalScore = round(score.finalScore, 3);
  survive('10_FINAL_SCORE', {
    input: {},
    features: { final_score: finalScore, weighted_formula: '0.55*top2_drivers + 0.45*gates, boundary caps applied' },
    score: { before: null, after: finalScore },
  });

  // 11 RANKING — assigned by episode-level score sort in scripts/v13-tracer.ts.
  survive('11_RANKING', {
    features: { note: 'rank assigned by episode-level score sort in scripts/v13-tracer.ts' },
  });

  // 12 ACCEPTANCE_THRESHOLD
  if (score.finalScore < clipThreshold) {
    die('12_ACCEPTANCE_THRESHOLD', `score ${round(score.finalScore, 1)} < ${clipThreshold}`, 'BELOW_CLIP_THRESHOLD', {
      input: { candidate_score: finalScore },
      threshold: { min: clipThreshold },
    });
    if (!bypassing('12_ACCEPTANCE_THRESHOLD')) return finalize();
    survive('12_ACCEPTANCE_THRESHOLD', { features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
  } else {
    survive('12_ACCEPTANCE_THRESHOLD', {
      input: { candidate_score: finalScore },
      threshold: { min: clipThreshold },
    });
  }

  // 13 FINAL_ACCEPTED
  survive('13_FINAL_ACCEPTED', {
    input: { candidate_id: candidateId },
    features: { accepted: true, tier: tierForScore(score.finalScore) },
  });

  return finalize();
}