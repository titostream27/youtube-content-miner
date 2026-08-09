/**
 * Brief V14 — offline replay engine (policy seam). Mirrors production order
 * of src/lib/v13r/trace.ts; C0 equals V13 outcomes (golden tests enforce).
 */
import { config } from '@/lib/config';
import type { MomentSegment, Transcript } from '@/lib/domain/types';
import { cuesToUtterances, sliceTranscriptForRange } from '@/lib/moments/utterances';
import { validateStartBoundary, type StartBoundaryResult } from '@/lib/moments/start-boundary';
import { expandStartBackToComplete, startBoundaryNeedsReject } from '@/lib/moments/start-gate';
import { repairBoundary } from '@/lib/moments/boundary-repair';
import { judgeSegmentHeuristically } from '@/lib/ai';
import { computeClipScore } from '@/lib/scoring/clip-score';
import { round } from '@/lib/scoring/normalize';
import { tierForScore } from '@/lib/domain/thresholds';
import type { LineageRow } from '@/lib/v12r/sampling';
import { decideEnding, type EndingPolicy } from './ending-policy';
import {
  V14_STAGES,
  deterministicNormalization,
  evidenceAt,
  nullDecision,
  stableHash,
  type V14ReplayResult,
  type V14StageName,
  type V14StageRow,
} from './replay-helpers';

export interface V14RunOptions {
  run_id?: string;
  parent_run_id?: string | null;
  variant_id?: string;
  endingPolicy: EndingPolicy;
  /** S2: score penalty when start shows only soft (LATE_HOOK) uncertainty. */
  startUncertaintyPenalty?: number;
  clipThreshold?: number;
  permissive?: boolean;
  seed?: string;
  configHash?: string;
  codeSha?: string;
}

type DecisionReturn = ReturnType<typeof decideEnding>;

export function replayCandidateV14(
  lineageRow: LineageRow,
  transcript: Transcript,
  opts: V14RunOptions,
): V14ReplayResult {
  const h = config.pipeline.highlight;
  const clipThreshold = opts.clipThreshold ?? config.pipeline.clipScoreThreshold;
  const startPenalty = opts.startUncertaintyPenalty ?? 0;
  const variantId = opts.variant_id ?? 'C0';
  const permissive = opts.permissive === true;

  const candidateId = lineageRow.candidate_id ?? 'unknown';
  const episodeId = lineageRow.episode_id ?? 'unknown';
  const roughStart = lineageRow.rough_start_sec ?? 0;
  const roughEnd = lineageRow.rough_end_sec ?? 0;
  const finalStartRaw = lineageRow.final_start_sec ?? null;
  const finalEndRaw = lineageRow.final_end_sec ?? null;
  const utterances = cuesToUtterances(transcript.cues) as import('@/lib/moments/utterances').EnrichedSentence[];

  const steps: V14StageRow[] = [];
  let firstDeath: V14StageName | null = null;
  let firstDeathReason: string | null = null;
  let exec = 0;

  const record = (row: Omit<V14StageRow, 'execution_index'> & { execution_index?: number | null }): void => {
    const full: V14StageRow = { execution_index: row.execution_index ?? null, ...row };
    steps.push(full);
    if (full.status === 'DIED' && firstDeath === null) {
      firstDeath = full.stage_name;
      firstDeathReason = full.explanation;
    }
  };
  const die = (
    stage: V14StageName,
    decision: DecisionReturn,
    reason: string,
    evidence: Record<string, unknown>,
    explanation: string,
  ): void => {
    exec += 1;
    record({
      stage_id: stage,
      stage_name: stage,
      execution_index: exec,
      reached: true,
      bypassed: false,
      status: 'DIED',
      semantic_state: decision.state ?? null,
      raw_confidence: decision.raw_confidence ?? null,
      observed_invalidity: decision.observed_invalidity,
      action: 'HARD_REJECT',
      reason_code: reason,
      evidence_refs: decision.evidence_refs,
      evidence,
      score_before: null,
      delta: null,
      score_after: null,
      explanation,
    });
  };

/* __PART2__ */

  const survive = (
    stage: V14StageName,
    decision: DecisionReturn,
    reason: string,
    evidence: Record<string, unknown>,
    explanation: string,
    scores: { before: number | null; after: number | null } = { before: null, after: null },
  ): void => {
    exec += 1;
    record({
      stage_id: stage,
      stage_name: stage,
      execution_index: exec,
      reached: true,
      bypassed: false,
      status: 'SURVIVED',
      semantic_state: decision.state ?? null,
      raw_confidence: decision.raw_confidence ?? null,
      observed_invalidity: decision.observed_invalidity === true ? true : null,
      action: decision.action,
      reason_code: reason,
      evidence_refs: decision.evidence_refs,
      evidence,
      score_before: scores.before,
      delta: scores.after !== null && scores.before !== null ? round(scores.after - scores.before, 3) : null,
      score_after: scores.after,
      explanation,
    });
  };

  const notReached = (stage: V14StageName): void => {
    record({
      stage_id: stage,
      stage_name: stage,
      execution_index: null,
      reached: false,
      bypassed: false,
      status: 'NOT_REACHED',
      semantic_state: null,
      raw_confidence: null,
      observed_invalidity: null,
      action: 'NOT_REACHED',
      reason_code: null,
      evidence_refs: [],
      evidence: {},
      score_before: null,
      delta: null,
      score_after: null,
      explanation: firstDeath !== null ? `not reached (first death at ${firstDeath})` : 'not reached',
    });
  };

  const finalize = (
    finalScore: number | null,
    originalScore: number | null,
    penaltyTotal: number,
    contributions: { component: string; delta: number | null; note: string }[],
    contamination: number | null,
  ): V14ReplayResult => {
    const reachedSet = new Set(steps.filter((s) => s.reached).map((s) => s.stage_id));
    for (const stage of V14_STAGES) {
      if (!reachedSet.has(stage)) notReached(stage);
    }
    const orderOf: Map<string, number> = new Map(V14_STAGES.map((s, i) => [s, i]));
    const seen = new Set<string>();
    const ordered = steps
      .filter((s) => {
        if (seen.has(s.stage_id)) return false;
        seen.add(s.stage_id);
        return true;
      })
      .sort((a, b) => {
        if (a.execution_index === null && b.execution_index === null) {
          return (orderOf.get(a.stage_id) ?? 99) - (orderOf.get(b.stage_id) ?? 99);
        }
        if (a.execution_index === null) return 1;
        if (b.execution_index === null) return -1;
        return a.execution_index - b.execution_index;
      });
    const acceptedStep = ordered.find((s) => s.stage_id === '13_FINAL_ACCEPTED');
    return {
      run_id: opts.run_id ?? `${variantId}:${candidateId}`,
      parent_run_id: opts.parent_run_id ?? null,
      candidate_id: candidateId,
      episode_id: episodeId,
      variant_id: variantId,
      config_hash: opts.configHash ?? stableHash(JSON.stringify({ ...h, clipThreshold })),
      code_sha: opts.codeSha ?? 'dev',
      seed: opts.seed ?? 'deterministic',
      stages: ordered,
      window: { start_sec: finalStart, end_sec: finalEnd },
      first_death: firstDeath,
      first_death_reason: firstDeathReason,
      survived_to_scoring: steps.some((s) => s.stage_id === '09_COMPONENT_SCORING' && s.status === 'SURVIVED'),
      final_accepted: acceptedStep !== undefined && acceptedStep.status === 'SURVIVED',
      final_score: finalScore === null ? null : round(finalScore, 3),
      original_score: originalScore === null ? null : round(originalScore, 3),
      soft_penalty_total: penaltyTotal,
      score_contributions: contributions,
      contamination,
    };
  };

/* __PART3__ */

  let finalStart = finalStartRaw ?? roughStart;
  let finalEnd = finalEndRaw ?? roughEnd;

  // 00 LINEAGE_PRESENT
  if (!lineageRow.candidate_id) {
    die('00_LINEAGE_PRESENT', nullDecision(), 'NO_LINEAGE_ROW', { candidate_id: candidateId }, 'candidate not present in lineage');
    return finalize(null, null, 0, [], null);
  }
  survive('00_LINEAGE_PRESENT', nullDecision(), 'OK', { candidate_id: candidateId, episode_id: episodeId }, '00_LINEAGE_PRESENT passed');

  // 01 PROPOSAL_VALID
  const proposalValid = Number.isFinite(roughStart) && Number.isFinite(roughEnd) && roughEnd > roughStart;
  if (!proposalValid) {
    die('01_PROPOSAL_VALID', nullDecision(), 'INVALID_PROPOSAL', { rough_start_sec: roughStart, rough_end_sec: roughEnd }, `invalid proposal range (${roughStart}-${roughEnd})`);
    return finalize(null, null, 0, [], null);
  }
  survive('01_PROPOSAL_VALID', nullDecision(), 'OK', { rough_start_sec: roughStart, rough_end_sec: roughEnd, rough_duration_sec: round(roughEnd - roughStart, 2) }, '01_PROPOSAL_VALID passed');

  // 02 TEMPORAL_NORMALIZATION
  const normalizedFromRough = finalStartRaw === null || finalEndRaw === null;
  if (normalizedFromRough) {
    const norm = deterministicNormalization(utterances, roughStart, roughEnd, h.nextTopicLookaheadSec, h.endGuardSec);
    finalStart = norm.startSec;
    finalEnd = norm.endSec;
  }
  if (!Number.isFinite(finalStart) || !Number.isFinite(finalEnd) || finalEnd < finalStart) {
    die('02_TEMPORAL_NORMALIZATION', nullDecision(), 'TEMPORAL_INVALID', { final_start_sec: finalStart, final_end_sec: finalEnd }, `negative/zero duration or non-finite final range (${finalStart}-${finalEnd})`);
    return finalize(null, null, 0, [], null);
  }
  survive('02_TEMPORAL_NORMALIZATION', nullDecision(), 'OK', {
    final_start_sec: finalStart,
    final_end_sec: finalEnd,
    final_duration_sec: round(finalEnd - finalStart, 2),
    normalized_from_deterministic_boundary: normalizedFromRough,
  }, '02_TEMPORAL_NORMALIZATION passed');

  const finalDuration = (): number => finalEnd - finalStart;
  const hardMax = h.hardMaxSec;
  const minDur = h.minCompleteDurationSec;

  // ── END-side gates first (production validateBoundary order, one repair attempt) ──
  let ev = evidenceAt(utterances, finalEnd, h.nextTopicLookaheadSec);

  const failingStage = (): { stage: V14StageName; decision: DecisionReturn; reason: string } | null => {
    if (permissive) return null;
    if (finalDuration() > hardMax) {
      return { stage: '07_DURATION_GATE', decision: nullDecision(), reason: 'DURATION_HARD_MAX' };
    }
    const decision = decideEnding(ev.ending, opts.endingPolicy);
    if (decision.action === 'HARD_REJECT' && decision.reason_code === 'ENDING_CONFIDENCE_LOW') {
      // Production semantics: the confidence floor is evaluated only when the
      // (possibly repaired) window is long enough to assess an ending. Short
      // candidates pass this gate and die later (07/03/12) instead.
      if (finalDuration() >= h.preferredMinSec) {
        return { stage: '05_ENDING_CONFIDENCE', decision, reason: 'ENDING_CONFIDENCE_LOW' };
      }
    } else if (decision.action === 'HARD_REJECT') {
      return { stage: '04_ENDING_COMPLETE', decision, reason: decision.reason_code ?? 'ENDING_INCOMPLETE' };
    }
    if (ev.boundary.contamination > h.maxNextTopicContamination) {
      return { stage: '06_CONTAMINATION_GATE', decision: nullDecision(), reason: 'NEXT_TOPIC_CONTAMINATION' };
    }
    if (finalDuration() < minDur) {
      return { stage: '07_DURATION_GATE', decision: nullDecision(), reason: 'DURATION_MIN' };
    }
    return null;
  };

  let fail = failingStage();
  let repairedEnd = false;
  if (fail !== null) {
    const preferEnd = ev.boundary.nextTopicStart !== null ? ev.boundary.nextTopicStart - h.endGuardSec : roughEnd;
    const repair = repairBoundary(utterances, { roughStartSec: roughStart, roughEndSec: roughEnd }, preferEnd);
    if (repair.boundaryStatus === 'repaired' || repair.boundaryStatus === 'refined') {
      finalStart = repair.finalStartSec;
      finalEnd = repair.finalEndSec;
      ev = evidenceAt(utterances, finalEnd, h.nextTopicLookaheadSec);
      repairedEnd = true;
      fail = failingStage();
    }
  }

  if (fail !== null) {
    die(fail.stage, fail.decision, fail.reason, {
      ending_type: ev.ending.endingType,
      ending_confidence: ev.ending.endingConfidence,
      ending_complete: ev.ending.endingComplete,
      semantic_state: fail.decision.state ?? null,
      repair_attempted: true,
      repaired_end: repairedEnd,
    }, `${fail.reason} (after repair attempt)`);
    return finalize(null, null, 0, [], round(ev.boundary.contamination, 4));
  }

  const endDecision = decideEnding(ev.ending, opts.endingPolicy);
  const endingContamination = round(ev.boundary.contamination, 4);
  survive('04_ENDING_COMPLETE', endDecision, endDecision.action === 'SOFT_PENALTY' ? 'ENDING_UNCERTAINTY' : 'OK', {
    ending_type: ev.ending.endingType,
    ending_complete: ev.ending.endingComplete,
    semantic_state: endDecision.state,
    observed_invalidity: false,
    repaired_end: repairedEnd,
  }, `ending evidence: ${endDecision.state} (${ev.ending.endingType})`);
  survive('05_ENDING_CONFIDENCE', endDecision, endDecision.action === 'SOFT_PENALTY' ? 'ENDING_CONFIDENCE_LOW' : 'OK', {
    ending_confidence: ev.ending.endingConfidence,
    floor: opts.endingPolicy.floor,
    soft_penalty: endDecision.soft_penalty,
    soft_penalty_cap: opts.endingPolicy.penaltyCap,
    duration_sec: round(finalDuration(), 2),
  }, endDecision.action === 'SOFT_PENALTY' ? `soft penalty ${endDecision.soft_penalty} (uncertainty)` : 'ending confidence passes');
  survive('06_CONTAMINATION_GATE', nullDecision(), 'OK', {
    contamination: endingContamination,
    next_topic_detected: ev.boundary.nextTopicDetected,
  }, 'contamination within bound');
  survive('07_DURATION_GATE', nullDecision(), 'OK', {
    duration_sec: round(finalDuration(), 2),
    repaired_end: repairedEnd,
    min: minDur,
    hard_max: hardMax,
  }, 'duration within [min, hard_max]');

/* __PART4__ */

  // ── START gate (finalizeCandidate path) after end gates ──
  let startCheck: StartBoundaryResult = validateStartBoundary(utterances, finalStart, finalEnd);
  let repairedStart: number | null = null;
  let startHard = startBoundaryNeedsReject(startCheck.issues ?? []);
  if (startHard) {
    const expanded = expandStartBackToComplete(utterances, finalStart);
    if (expanded !== null && expanded < finalStart) {
      const recheck = validateStartBoundary(utterances, expanded, finalEnd);
      if (!startBoundaryNeedsReject(recheck.issues ?? [])) {
        repairedStart = expanded;
        finalStart = expanded;
        startCheck = recheck;
        startHard = false;
      }
    }
  }
  if (startHard && !permissive) {
    die('03_START_GATE', nullDecision(), 'START_GATE_HARD', {
      issues: startCheck.issues ?? [],
      start_complete: startCheck.startComplete,
      hook_delay_sec: startCheck.hookDelaySec,
    }, `start gate hard failure: ${(startCheck.issues ?? []).join(',')}`);
    return finalize(null, null, 0, [{ component: 'start_gate', delta: null, note: 'hard rejected at start' }], null);
  }
  const startIssues = startCheck.issues ?? [];
  const startSoft = startIssues.length > 0 && startIssues.includes('LATE_HOOK');
  survive('03_START_GATE', nullDecision(), startSoft ? 'START_SOFT_UNCERTAINTY' : 'OK', {
    issues: startIssues,
    start_complete: startCheck.startComplete,
    start_repaired_to: repairedStart,
    start_repair_used: repairedStart !== null,
    start_uncertainty_penalty: startPenalty > 0 && startSoft ? startPenalty : 0,
  }, startSoft ? 'soft start uncertainty only' : 'start boundary complete');

  // 08 DUPLICATE_OVERLAP — herd handled by the runner.
  survive('08_DUPLICATE_OVERLAP', nullDecision(), 'OK', { note: 'overlap resolution applied at proposal time; herd in runner' }, '08_DUPLICATE_OVERLAP passed');

  // ── SCORING (9/10) with soft-penalty accounting ──
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
    generationRunId: `v14-${variantId}`,
    revision: 0,
  };
  const judgement = judgeSegmentHeuristically(seg);
  const score = computeClipScore(judgement.dimensions, { durationSec: finalEnd - finalStart });
  const contributions: { component: string; delta: number | null; note: string }[] = [];
  for (const [key, value] of Object.entries(judgement.dimensions)) {
    contributions.push({ component: `dim.${key}`, delta: typeof value === 'number' ? round(value as number, 3) : null, note: 'heuristic dimension' });
  }
  contributions.push({ component: 'base_score', delta: round(score.baseScore, 3), note: '0.55*drivers + 0.45*gates' });
  contributions.push({ component: 'duration_multiplier', delta: round(score.durationMultiplier, 4), note: 'piecewise duration curve' });
  for (const cap of score.appliedCaps) {
    contributions.push({ component: 'cap', delta: null, note: cap.reason });
  }

  let penaltyTotal = 0;
  if (endDecision.action === 'SOFT_PENALTY' && endDecision.soft_penalty > 0) {
    penaltyTotal += endDecision.soft_penalty;
    contributions.push({ component: 'ending_uncertainty', delta: -endDecision.soft_penalty, note: `bounded soft penalty (${endDecision.state})` });
  }
  if (startPenalty > 0 && startSoft) {
    penaltyTotal += startPenalty;
    contributions.push({ component: 'start_uncertainty', delta: -startPenalty, note: 'soft-only start findings (S2)' });
  }

  const originalScore = score.finalScore;
  const finalScore = Math.max(0, score.finalScore - penaltyTotal);
  survive('09_COMPONENT_SCORING', nullDecision(), 'OK', {
    scoring_engine: 'heuristic',
    dimensions: judgement.dimensions,
    caps: score.appliedCaps.map((c) => c.reason),
  }, 'component scoring passed');
  survive('10_FINAL_SCORE', nullDecision(), 'OK', {
    final_score: round(finalScore, 3),
    original_score: round(originalScore, 3),
    soft_penalty_total: penaltyTotal,
  }, `final score ${round(finalScore, 1)} (penalty ${penaltyTotal})`, { before: null, after: round(finalScore, 3) });
  survive('11_RANKING', nullDecision(), 'OK', { note: 'rank assigned by episode-level score sort in runner' }, '11_RANKING passed');

  // 12 ACCEPTANCE_THRESHOLD
  if (permissive || finalScore >= clipThreshold) {
    survive('12_ACCEPTANCE_THRESHOLD', nullDecision(), 'OK', {
      candidate_score: round(finalScore, 3),
      threshold: clipThreshold,
    }, 'score meets threshold');
  } else {
    die('12_ACCEPTANCE_THRESHOLD', nullDecision(), 'BELOW_CLIP_THRESHOLD', {
      candidate_score: round(finalScore, 3),
      threshold: clipThreshold,
    }, `score ${round(finalScore, 1)} < ${clipThreshold}`);
    return finalize(round(finalScore, 3), round(originalScore, 3), penaltyTotal, contributions, endingContamination);
  }

  survive('13_FINAL_ACCEPTED', nullDecision(), 'OK', { accepted: true, tier: tierForScore(finalScore) }, 'accepted');
  return finalize(round(finalScore, 3), round(originalScore, 3), penaltyTotal, contributions, endingContamination);
}