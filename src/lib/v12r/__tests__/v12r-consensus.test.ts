import { describe, expect, it } from 'vitest';
import { decideConsensus, needsJudgeC } from '../consensus';
import type { JudgeCall } from '../judge-types';

/**
 * Brief V12R Phase G/M — Sanity fixtures AJ-01..AJ-07 (consensus path).
 * Deterministic fake judge calls; no network.
 */

function judge(
  publishable: boolean,
  confidence: number,
  overrides: Partial<Record<string, unknown>> = {},
): JudgeCall {
  return {
    tier: 'A',
    providerId: 'fixture',
    model: 'fixture-model',
    raw_text: '{}',
    output: {
      start_complete: true,
      setup_sufficient: true,
      context_independence: true,
      hook_score: 0.7,
      topic_cohesion: 0.8,
      payoff_score: 0.8,
      ending_complete: true,
      next_topic_leakage: false,
      hard_negative: false,
      standalone_score: 0.8,
      publishable,
      confidence,
      failure_reasons: [],
      repair_hint: { action: 'NONE', directional_seconds: 0, semantic_reason: 'fixture' },
      short_reason: 'fixture',
      ...overrides,
    },
    status: 'ok',
    error: null,
    attempts: 1,
    input_tokens: 10,
    output_tokens: 10,
    duration_ms: 1,
  };
}

function providerFailed(tier: 'A' | 'B' | 'C'): JudgeCall {
  return {
    tier,
    providerId: 'fixture',
    model: 'fixture-model',
    raw_text: '',
    output: null,
    status: 'provider_error',
    error: 'fixture provider failure',
    attempts: 2,
    input_tokens: null,
    output_tokens: null,
    duration_ms: 1,
  };
}

function parseFailed(tier: 'A' | 'B' | 'C'): JudgeCall {
  return {
    tier,
    providerId: 'fixture',
    model: 'fixture-model',
    raw_text: 'not json at all',
    output: null,
    status: 'parse_failure',
    error: 'fixture parse failure',
    attempts: 1,
    input_tokens: 10,
    output_tokens: null,
    duration_ms: 1,
  };
}

describe('V12R consensus matrix', () => {
  it('AJ-01 A+B agree PASS -> Consensus PASS', () => {
    const decision = decideConsensus(judge(true, 0.9), judge(true, 0.85), null, { confidenceFloor: 0.5 });
    expect(decision.label).toBe('PASS');
    expect(decision.judge_c_invoked).toBe(false);
  });

  it('AJ-02 A+B agree FAIL -> Consensus FAIL', () => {
    const decision = decideConsensus(judge(false, 0.9), judge(false, 0.85), null, { confidenceFloor: 0.5 });
    expect(decision.label).toBe('FAIL');
  });

  it('AJ-03 A/B disagree -> Judge C invoked', () => {
    const a = judge(true, 0.9);
    const b = judge(false, 0.8);
    expect(needsJudgeC(a, b, { confidenceFloor: 0.5 })).toBe(true);
    const decision = decideConsensus(a, b, judge(true, 0.8), { confidenceFloor: 0.5 });
    expect(decision.judge_c_invoked).toBe(true);
    expect(decision.label).toBe('PASS'); // 2-of-3 publishable
  });

  it('AJ-03b A/B disagree, Judge C sides with fail -> FAIL', () => {
    const decision = decideConsensus(judge(true, 0.9), judge(false, 0.8), judge(false, 0.7), { confidenceFloor: 0.5 });
    expect(decision.judge_c_invoked).toBe(true);
    expect(decision.label).toBe('FAIL');
  });

  it('AJ-04 judge provider failure -> no fake content label (REVIEW)', () => {
    const decision = decideConsensus(providerFailed('A'), judge(false, 0.9), null, { confidenceFloor: 0.5 });
    expect(decision.label).toBe('REVIEW');
    expect(decision.rule).toBe('INCOMPLETE_VOTES');
  });

  it('AJ-05 malformed judge JSON -> parser failure handling (REVIEW)', () => {
    const decision = decideConsensus(judge(true, 0.9), parseFailed('B'), null, { confidenceFloor: 0.5 });
    expect(decision.label).toBe('REVIEW');
  });

  it('AJ-06 majority leakage cannot PASS', () => {
    const a = judge(true, 0.9, { next_topic_leakage: true });
    const b = judge(false, 0.9, { next_topic_leakage: true });
    const c = judge(true, 0.9, { next_topic_leakage: false });
    const decision = decideConsensus(a, b, c, { confidenceFloor: 0.5 });
    expect(decision.label).toBe('REVIEW');
    expect(decision.rule).toBe('MAJORITY_CRITICAL_VETO');
    expect(decision.judge_c_invoked).toBe(true);
  });

  it('AJ-07 majority hard negative cannot PASS', () => {
    const a = judge(false, 0.9, { hard_negative: true });
    const b = judge(false, 0.9, { hard_negative: true });
    const decision = decideConsensus(a, b, null, { confidenceFloor: 0.5 });
    expect(decision.label).toBe('FAIL');
  });
});