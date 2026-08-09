/**
 * Brief V13 Phase B — Deterministic consensus hardening.
 *
 * Extends the V12R consensus with CRITICAL VETOES so a candidate can never
 * receive consensus PASS merely because judges set publishable=true while
 * critical completeness dimensions contradict that verdict.
 *
 * Required vetoes (brief §4.1):
 *   - majority: next_topic_leakage == true
 *   - majority: hard_negative == true
 *   - majority: ending_complete == false
 *   - majority: start_complete == false AND context_independence == false
 *
 * Majority semantics: a veto fires when MORE THAN HALF of the judges that
 * produced a content verdict flag the dimension (2-of-3 when Judge C was
 * invoked, both A and B when only two verdicts exist). A single dissenting
 * flag on a 2-judge pair is a disagreement -> Judge C is invoked; if C is
 * unavailable the verdict becomes REVIEW.
 *
 * Provider/parser failures are never content verdicts (V12R R6/R7): a
 * missing vote yields REVIEW unless the payload is unanimous FAIL.
 *
 * The veto_reason is persisted on every decision.
 */
import type { ConsensusDecision, JudgeCall, JudgeTier } from '@/lib/v12r/judge-types';
import { decideConsensus as decideConsensusV12 } from '@/lib/v12r/consensus';

export interface ConsensusOptionsV13 {
  /** Minimum confidence for a publishable vote. Default 0.5. */
  confidenceFloor?: number;
}

export interface HardenResult {
  decision: ConsensusDecision;
  /** Exact veto reason when the verdict was downgraded to REVIEW, else null. */
  veto_reason: string | null;
}

function contentJudge(call: JudgeCall): boolean {
  return call.status === 'ok' && call.output !== null;
}

/** Dimension flags observed on one judge's content verdict. */
interface DimensionFlags {
  next_topic_leakage: boolean;
  hard_negative: boolean;
  ending_complete: boolean;
  start_complete: boolean;
  context_independence: boolean;
}

function flagsOf(call: JudgeCall): DimensionVeto | null {
  if (!contentJudge(call) || !call.output) return null;
  return {
    next_topic_leakage: call.output.next_topic_leakage === true,
    hard_negative: call.output.hard_negative === true,
    ending_complete: call.output.ending_complete === true,
    start_complete: call.output.start_complete === true,
    context_independence: call.output.context_independence === true,
  };
}

interface DimensionVeto {
  next_topic_leakage: boolean;
  hard_negative: boolean;
  ending_complete: boolean;
  start_complete: boolean;
  context_independence: boolean;
}

/** Strict majority: > half of content verdicts must flag. */
function majorityFlag(flags: DimensionVeto[], pick: (f: DimensionVeto) => boolean): boolean {
  if (flags.length === 0) return false;
  const flagged = flags.filter(pick).length;
  return flagged * 2 > flags.length;
}

/** Veto reason when a majority of content verdicts contradicts PASS. */
export function vetoReasonOf(
  judgeA: JudgeCall,
  judgeB: JudgeCall,
  judgeC: JudgeCall | null,
): string | null {
  const flags: Array<DimensionVeto> = [];
  for (const call of [judgeA, judgeB, judgeC]) {
    if (!call) continue;
    const f = flagsOf(call);
    if (f) flags.push(f);
  }
  const reasons: string[] = [];
  if (majorityFlag(flags, (f) => f.next_topic_leakage)) reasons.push('majority(next_topic_leakage=true)');
  if (majorityFlag(flags, (f) => f.hard_negative)) reasons.push('majority(hard_negative=true)');
  if (majorityFlag(flags, (f) => !f.ending_complete)) reasons.push('majority(ending_complete=false)');
  if (
    majorityFlag(flags, (f) => !f.start_complete && !f.context_independence)
  ) {
    reasons.push('majority(start_complete=false && context_independence=false)');
  }
  return reasons.length > 0 ? reasons.join(' ; ') : null;
}

/**
 * V13 hardened consensus decision.
 *
 * Runs the V12R consensus first, then applies the critical veto floor:
 * any consensus PASS that stands on contradicting completeness dimensions is
 * downgraded to REVIEW with the exact veto reason. FAIL results stay FAIL.
 */
export function decideConsensusV13(
  judgeA: JudgeCall,
  judgeB: JudgeCall,
  judgeC: JudgeCall | null,
  opts: ConsensusOptionsV13 = {},
): HardenResult {
  const v12 = decideConsensusV12(judgeA, judgeB, judgeC, opts);

  // A FAIL verdict or a REVIEW verdict needs no extra veto pass.
  if (v12.label !== 'PASS') {
    return { decision: v12, veto_reason: null };
  }

  const veto = vetoReasonOf(judgeA, judgeB, judgeC);
  if (veto !== null) {
    return {
      decision: {
        ...v12,
        label: 'REVIEW',
        rule: 'V13_CRITICAL_VETO',
        reason: `PASS downgraded by critical veto: ${veto}`,
      },
      veto_reason: veto,
    };
  }
  return { decision: v12, veto_reason: null };
}

/**
 * V13-versioned label row (SA-20: labels tied to judge version/config).
 */
export function labelRowV13(
  candidateId: string,
  episodeId: string,
  window: { start_sec: number; end_sec: number },
  result: HardenResult,
  benchmarkVersion: string,
): Record<string, unknown> {
  return {
    benchmark_version: benchmarkVersion,
    candidate_id: candidateId,
    episode_id: episodeId,
    window,
    label: result.decision.label,
    rule: result.decision.rule,
    judge_c_invoked: result.decision.judge_c_invoked,
    reason: result.decision.reason,
    veto_reason: result.veto_reason,
    votes: result.decision.votes,
  };
}

/** Benchmark version string; env V13_BENCHMARK_VERSION or default. */
export function benchmarkVersion(): string {
  return process.env.V13_BENCHMARK_VERSION?.trim() || 'v13.0';
}