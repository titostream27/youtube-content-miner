/**
 * Brief V13 Phase E — Production stage replay (TRACE).
 *
 * Given an exact candidate window (from the frozen lineage), replay it
 * through the SAME production decision functions and emit a stage-by-stage
 * trace WITHOUT changing behavior. The replay calls real production logic:
 *   - validateStartBoundary / startBoundaryNeedsReject / expandStartBackToComplete
 *   - classifyEnding / detectTopicBoundary (topic-boundary module)
 *   - applyNextTopicGuard + validateBoundary semantics (two-pass guards)
 *   - repairBoundary (ending repair used by two-pass)
 *   - judgeSegmentHeuristically + computeClipScore (scoring path)
 *   - tierForScore / clipScoreThreshold (acceptance)
 *
 * Stages (brief §Phase E):
 *   00_LINEAGE_PRESENT          01_PROPOSAL_VALID       02_TEMPORAL_NORMALIZATION
 *   03_START_GATE               04_ENDING_COMPLETE      05_ENDING_CONFIDENCE
 *   06_CONTAMINATION_GATE       07_DURATION_GATE        08_DUPLICATE_OVERLAP
 *   09_COMPONENT_SCORING        10_FINAL_SCORE          11_RANKING
 *   12_ACCEPTANCE_THRESHOLD     13_FINAL_ACCEPTED
 *
 * For each stage: status = SURVIVED | DIED | NOT_REACHED, input values,
 * computed features, threshold/config used, score before/after, reason code,
 * human-readable explanation. The first DIED stage is the candidate's
 * first_death; subsequent stages are NOT_REACHED unless the stage is under
 * counterfactual bypass (callers pass overrides.bypass).
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
  /** Bypass one or more stages (counterfactual): the stage runs but its
   *  failure does not kill the candidate; downstream stages stay active. */
  bypass?: ReadonlySet<StageName>;
  altEndingConfidence?: number;
  altMaxContamination?: number;
  altMinCompleteDuration?: number;
  altHardMaxSec?: number;
  altClipScoreThreshold?: number;
}

/** Following utterances within a time horizon (brief v7 M01 semantics). */
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

/** Ending + topic-boundary evidence at a given end second. */
function evidenceAt(
  utterances: EnrichedSentence[],
  endSec: number,
  nextTopicLookaheadSec: number,
): { ending: EndingAnalysis; boundary: TopicBoundary; endIdx: number } {
  const endIdx = utteranceAtOrBefore(utterances, endSec);
  if (endIdx < 0) {
    return {
      ending: { endingType: 'UNKNOWN', endingConfidence: 0.45, endingComplete: false },
      boundary: { nextTopicDetected: false, nextTopicStart: null, contamination: 0 },
      endIdx,
    };
  }
  const endU = utterances[endIdx]!;
  const nxt = endIdx + 1 < utterances.length ? utterances[endIdx + 1]! : null;
  const following = followingWithinLookaheadSec(
    utterances,
    endIdx,
    endU.endSec,
    nextTopicLookaheadSec,
  );
  return {
    ending: classifyEnding(endU, nxt, following),
    boundary: nxt
      ? detectTopicBoundary(endU, nxt, following, nextTopicLookaheadSec)
      : { nextTopicDetected: false, nextTopicStart: null, contamination: 0 },
    endIdx,
  };
}

/** Production next-topic guard (§7): never cross into the next topic. */
function applyNextTopicGuard(
  selectedEnd: number,
  boundary: TopicBoundary,
  endGuardSec: number,
): number {
  if (boundary.nextTopicDetected && boundary.nextTopicStart !== null) {
    const guarded = boundary.nextTopicStart - endGuardSec;
    if (guarded < selectedEnd) return Math.max(0, guarded);
  }
  return selectedEnd;
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

  const record = (step: StageStep): StageStep => {
    steps.push(step);
    if (step.status === 'DIED') {
      firstDeath = firstDeath ?? step.stage;
      firstDeathReason = firstDeathReason ?? step.explanation;
    }
    return step;
  };
  const die = (stage: StageName, reason: string, code: string, extra: Partial<StageStep> = {}): StageStep =>
    record({ stage, status: 'DIED', input: {}, features: {}, threshold: {}, score: { before: null, after: null }, reason_code: code, explanation: reason, ...extra });
  const survive = (stage: StageName, extra: Partial<StageStep> = {}): StageStep =>
    record({ stage, status: 'SURVIVED', input: {}, features: {}, threshold: {}, score: { before: null, after: null }, reason_code: 'OK', explanation: `${stage} passed`, ...extra });

  const bypassing = (stage: StageName): boolean =>
    overrides.bypass !== undefined && overrides.bypass.has(stage);

  const finalize = (): TraceResult => {
    // Append NOT_REACHED for every stage after the first death so the trace
    // always carries the full 14-stage schema (brief Phase E).
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
    die('01_PROPOSAL_VALID', `invalid proposal window (${roughStart}-${roughEnd})`, 'INVALID_PROPOSAL', {
      input: { rough_start_sec: roughStart, rough_end_sec: roughEnd },
    });
    if (!bypassing('01_PROPOSAL_VALID')) return finalize();
    survive('01_PROPOSAL_VALID', { explanation: 'bypassed (counterfactual)' });
  } else {
    survive('01_PROPOSAL_VALID', {
      input: { rough_start_sec: roughStart, rough_end_sec: roughEnd, rough_duration_sec: round(roughEnd - roughStart, 2) },
    });
  }

  // 02 TEMPORAL_NORMALIZATION
  const temporalValid = Number.isFinite(finalStart) && Number.isFinite(finalEnd) && finalEnd >= finalStart;
  if (!temporalValid) {
    if (!bypassing('02_TEMPORAL_NORMALIZATION')) {
      die('02_TEMPORAL_NORMALIZATION', `negative/zero duration or non-finite final range (${finalStart}-${finalEnd})`, 'TEMPORAL_INVALID', {
        input: { final_start_sec: finalStart, final_end_sec: finalEnd },
        threshold: { invariant: 'final_end >= final_start; both finite' },
      });
      return finalize();
    }
    survive('02_TEMPORAL_NORMALIZATION', { features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
  } else {
    survive('02_TEMPORAL_NORMALIZATION', {
      input: { final_start_sec: finalStart, final_end_sec: finalEnd },
      features: { final_duration_sec: round(finalEnd - finalStart, 2) },
      threshold: { invariant: 'final_end >= final_start; both finite' },
    });
  }

  // 03 START_GATE — production start validation + bounded repair.
  {
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
      survive('03_START_GATE', { input: { start_sec: finalStart, end_sec: finalEnd }, features: { issues: startCheck.issues ?? [], bypassed: true }, explanation: 'bypassed (counterfactual)' });
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
  }

  // 04..07 — ending / confidence / contamination / duration in production
  // validateBoundary order (hardMax -> endingComplete -> confidence ->
  // contamination -> minCompleteDuration).
  {
    let ev = evidenceAt(utterances, finalEnd, h.nextTopicLookaheadSec);
    const finalDuration = () => finalEnd - finalStart;
    const hardMax = overrides.altHardMaxSec ?? h.hardMaxSec;

    // 07a DURATION hard max (production checks it first).
    if (finalDuration() > hardMax) {
      if (!bypassing('07_DURATION_GATE')) {
        die('07_DURATION_GATE', `exceeds hard max (${round(finalDuration(), 1)}s > ${hardMax}s)`, 'DURATION_HARD_MAX', {
          input: { start_sec: finalStart, end_sec: finalEnd },
          features: { duration_sec: round(finalDuration(), 2) },
          threshold: { hard_max_sec: hardMax },
        });
        return finalize();
      }
      survive('07_DURATION_GATE', { features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
    }

    // 04 ENDING_COMPLETE (with production repair-before-reject).
    if (!ev.ending.endingComplete) {
      const preferEnd = ev.boundary.nextTopicStart !== null
        ? ev.boundary.nextTopicStart - h.endGuardSec
        : roughEnd;
      const repair = repairBoundary(utterances, { roughStartSec: finalStart, roughEndSec: finalEnd }, preferEnd);
      if (repair.boundaryStatus === 'repaired' || repair.boundaryStatus === 'refined') {
        finalEnd = repair.finalEndSec;
        ev = evidenceAt(utterances, finalEnd, h.nextTopicLookaheadSec);
        if (ev.ending.endingComplete) {
          survive('04_ENDING_COMPLETE', {
            input: { end_sec: finalEnd },
            features: { original_ending_type: ev.ending.endingType, repaired_to: round(finalEnd, 2) },
            threshold: { rule: 'repair before reject' },
            explanation: 'ending repaired to a complete boundary',
          });
        } else {
          if (!bypassing('04_ENDING_COMPLETE')) {
            die('04_ENDING_COMPLETE', `ending incomplete after repair (${ev.ending.endingType})`, 'ENDING_INCOMPLETE', {
              input: { end_sec: finalEnd },
              features: { ending_type: ev.ending.endingType, ending_confidence: ev.ending.endingConfidence },
            });
            return finalize();
          }
          survive('04_ENDING_COMPLETE', { features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
        }
      } else {
        if (!bypassing('04_ENDING_COMPLETE')) {
          die('04_ENDING_COMPLETE', `ending incomplete (${ev.ending.endingType}); repair ${repair.boundaryStatus}`, 'ENDING_INCOMPLETE', {
            input: { end_sec: finalEnd },
            features: { ending_type: ev.ending.endingType, ending_confidence: ev.ending.endingConfidence, repair_status: repair.boundaryStatus },
          });
          return finalize();
        }
        survive('04_ENDING_COMPLETE', { features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
      }
    } else {
      survive('04_ENDING_COMPLETE', {
        input: { end_sec: finalEnd },
        features: { ending_type: ev.ending.endingType, ending_complete: true, ending_confidence: ev.ending.endingConfidence },
      });
    }

    // 05 ENDING_CONFIDENCE
    const minEndingConf = overrides.altEndingConfidence ?? h.minEndingConfidence;
    if (ev.ending.endingConfidence < minEndingConf && finalDuration() >= h.preferredMinSec) {
      if (!bypassing('05_ENDING_CONFIDENCE')) {
        die('05_ENDING_CONFIDENCE',
          `ending confidence ${ev.ending.endingConfidence.toFixed(2)} < ${minEndingConf}`,
          'ENDING_CONFIDENCE_LOW',
          {
            input: { end_sec: finalEnd },
            features: { ending_confidence: ev.ending.endingConfidence, duration_sec: round(finalDuration(), 2) },
            threshold: { min: minEndingConf, preferred_min_sec: h.preferredMinSec },
          });
        return finalize();
      }
      survive('05_ENDING_CONFIDENCE', { input: { end_sec: finalEnd }, features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
    } else {
      survive('05_ENDING_CONFIDENCE', {
        input: { end_sec: finalEnd },
        features: { ending_confidence: ev.ending.endingConfidence, duration_sec: round(finalDuration(), 2) },
        threshold: { min: minEndingConf, preferred_min_sec: h.preferredMinSec },
      });
    }

    // 06 CONTAMINATION
    const maxContamination = overrides.altMaxContamination ?? h.maxNextTopicContamination;
    if (ev.boundary.contamination > maxContamination) {
      if (!bypassing('06_CONTAMINATION_GATE')) {
        die('06_CONTAMINATION_GATE',
          `next-topic contamination ${ev.boundary.contamination.toFixed(2)} > ${maxContamination}`,
          'NEXT_TOPIC_CONTAMINATION',
          {
            input: { end_sec: finalEnd },
            features: { contamination: ev.boundary.contamination, next_topic_detected: ev.boundary.nextTopicDetected },
            threshold: { max: maxContamination },
          });
        return finalize();
      }
      survive('06_CONTAMINATION_GATE', { input: { end_sec: finalEnd }, features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
    } else {
      survive('06_CONTAMINATION_GATE', {
        input: { end_sec: finalEnd },
        features: { contamination: ev.boundary.contamination, next_topic_detected: ev.boundary.nextTopicDetected },
        threshold: { max: maxContamination },
      });
    }

    // 07b DURATION min + preferred range (after hard max already passed).
    const minDur = overrides.altMinCompleteDuration ?? h.minCompleteDurationSec;
    if (finalDuration() < minDur) {
      if (!bypassing('07_DURATION_GATE')) {
        die('07_DURATION_GATE', `too short (${round(finalDuration(), 1)}s < ${minDur}s)`, 'DURATION_MIN', {
          input: { start_sec: finalStart, end_sec: finalEnd },
          features: { duration_sec: round(finalDuration(), 2) },
          threshold: { min: minDur },
        });
        return finalize();
      }
      survive('07_DURATION_GATE', { input: { start_sec: finalStart, end_sec: finalEnd }, features: { duration_sec: round(finalDuration(), 2), bypassed: true }, explanation: 'bypassed (counterfactual)' });
    } else {
      survive('07_DURATION_GATE', {
        input: { start_sec: finalStart, end_sec: finalEnd },
        features: { duration_sec: round(finalDuration(), 2) },
        threshold: { min: minDur, hard_max: hardMax, preferred: [h.preferredMinSec, h.preferredMaxSec] },
      });
    }
  }

  // 08 DUPLICATE / OVERLAP RESOLUTION.
  // Production performs greedy non-overlapping selection at proposal time
  // (detectMoments); the lineage already contains only produced candidates.
  // Herd-level suppression analysis happens in scripts/v13-trace.ts.
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

  // 11 RANKING — assigned by episode-level sort in the tracer script.
  survive('11_RANKING', {
    features: { note: 'rank assigned by episode-level score sort in scripts/v13-trace.ts' },
  });

  // 12 ACCEPTANCE_THRESHOLD
  if (score.finalScore < clipThreshold) {
    if (!bypassing('12_ACCEPTANCE_THRESHOLD')) {
      die('12_ACCEPTANCE_THRESHOLD', `score ${round(score.finalScore, 1)} < ${clipThreshold}`, 'BELOW_CLIP_THRESHOLD', {
        input: { candidate_score: finalScore },
        threshold: { min: clipThreshold },
      });
      return finalize();
    }
    survive('12_ACCEPTANCE_THRESHOLD', { input: { candidate_score: finalScore }, features: { bypassed: true }, explanation: 'bypassed (counterfactual)' });
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
