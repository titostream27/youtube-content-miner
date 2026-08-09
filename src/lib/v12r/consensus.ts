/**
 * Brief V12R Phase F — Deterministic consensus.
 *
 *   A + B both publishable AND above the confidence floor AND no critical
 *     rule contradiction        => PASS
 *   A + B both non-publishable  => FAIL
 *   A/B disagree                => invoke Judge C
 *   After C: 2-of-3 publishable may PASS only if critical rules pass,
 *   otherwise FAIL or REVIEW.
 *
 * Provider/parse failures are NEVER converted into a content label (R6, R7):
 * a missing vote yields REVIEW, not PASS/FAIL, unless the remaining votes
 * are unanimous on FAIL.
 */
import type { ConsensusDecision, JudgeCall, JudgeTier } from './judge-types';

export interface ConsensusOptions {
  /** Minimum confidence for a publishable vote to count. Default 0.5. */
  confidenceFloor?: number;
}

export function consensusOptions(): ConsensusOptions {
  const raw = process.env.V12R_JUDGE_CONFIDENCE_FLOOR?.trim();
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  return { confidenceFloor: Number.isFinite(parsed) ? parsed : 0.5 };
}

function votePublishable(call: JudgeCall, floor: number): boolean | null {
  if (call.status !== 'ok' || !call.output) return null;
  return call.output.publishable === true && call.output.confidence >= floor;
}

function criticalVeto(call: JudgeCall): boolean | null {
  if (call.status !== 'ok' || !call.output) return null;
  return call.output.next_topic_leakage === true || call.output.hard_negative === true;
}

/**
 * Whether Judge C is required for this pair: both A and B produced a valid
 * vote, and they disagree on publishability (or one failed — C can replace
 * the missing opinion only when the other two cannot decide).
 */
export function needsJudgeC(judgeA: JudgeCall, judgeB: JudgeCall, opts: ConsensusOptions = {}): boolean {
  const floor = opts.confidenceFloor ?? consensusOptions().confidenceFloor ?? 0.5;
  if (judgeA.status !== 'ok' || judgeB.status !== 'ok') return false;
  const aPub = votePublishable(judgeA, floor);
  const bPub = votePublishable(judgeB, floor);
  return aPub !== bPub;
}

export function decideConsensus(
  judgeA: JudgeCall,
  judgeB: JudgeCall,
  judgeC: JudgeCall | null,
  opts: ConsensusOptions = {},
): ConsensusDecision {
  const floor = opts.confidenceFloor ?? consensusOptions().confidenceFloor ?? 0.5;

  const aPub = votePublishable(judgeA, floor);
  const bPub = votePublishable(judgeB, floor);
  const aVeto = criticalVeto(judgeA);
  const bVeto = criticalVeto(judgeB);
  const cVeto = judgeC ? criticalVeto(judgeC) : null;

  const votes = [
    { tier: 'A' as JudgeTier, publishable: aPub, critical_veto: aVeto, confident: aPub === true },
    { tier: 'B' as JudgeTier, publishable: bPub, critical_veto: bVeto, confident: bPub === true },
    ...(judgeC
      ? [{ tier: 'C' as JudgeTier, publishable: votePublishable(judgeC, floor), critical_veto: cVeto, confident: votePublishable(judgeC, floor) === true }]
      : []),
  ];

  const twoVotes = judgeA.status === 'ok' && judgeB.status === 'ok';

  // A + B agree PASS.
  if (twoVotes && aPub === true && bPub === true) {
    if (aVeto === true || bVeto === true) {
      return {
        label: 'REVIEW',
        rule: 'AB_AGREE_PUBLISHABLE_BUT_CRITICAL_VETO',
        votes,
        judge_c_invoked: false,
        reason: 'both judges say publishable but at least one flags hard_negative/next_topic_leakage',
      };
    }
    return { label: 'PASS', rule: 'AB_PASS', votes, judge_c_invoked: false, reason: 'A and B both publishable above floor, no critical veto' };
  }

  // A + B agree FAIL.
  if (twoVotes && aPub === false && bPub === false) {
    // A unanimous fail with a critical hard negative is still FAIL.
    return { label: 'FAIL', rule: 'AB_FAIL', votes, judge_c_invoked: false, reason: 'A and B both non-publishable' };
  }

  // Disagreement or a missing judge -> Judge C is invoked when available.
  const invokeC = judgeC && (judgeC.status === 'ok') && (aPub !== bPub || aPub === null || bPub === null);
  if (invokeC) {
    const cPub = votePublishable(judgeC as JudgeCall, floor);

    const publishableVotes = [aPub, bPub, cPub].filter((v) => v === true).length;
    const nonPublishableVotes = [aPub, bPub, cPub].filter((v) => v === false).length;
    const vetoCount = [aVeto, bVeto, cVeto].filter((v) => v === true).length;

    if (vetoCount >= 2) {
      return {
        label: 'REVIEW',
        rule: 'MAJORITY_CRITICAL_VETO',
        votes,
        judge_c_invoked: true,
        reason: 'majority of judges flags hard_negative or next_topic_leakage — cannot PASS',
      };
    }
    if (publishableVotes >= 2) {
      return { label: 'PASS', rule: 'C_2OF3_PASS', votes, judge_c_invoked: true, reason: '2-of-3 publishable and no critical veto majority' };
    }
    if (nonPublishableVotes >= 2) {
      return { label: 'FAIL', rule: 'C_2OF3_FAIL', votes, judge_c_invoked: true, reason: '2-of-3 non-publishable' };
    }
    return { label: 'REVIEW', rule: 'C_SPLIT', votes, judge_c_invoked: true, reason: 'no clear majority after Judge C' };
  }

  // Missing votes -> honest REVIEW, never fake PASS/FAIL (R6/R7).
  return {
    label: 'REVIEW',
    rule: 'INCOMPLETE_VOTES',
    votes,
    judge_c_invoked: false,
    reason: `insufficient judge votes (A=${judgeA.status}, B=${judgeB.status}${judgeC ? `, C=${judgeC.status}` : ''})`,
  };
}