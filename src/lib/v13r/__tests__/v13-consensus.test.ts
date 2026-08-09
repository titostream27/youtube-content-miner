/**
 * Brief V13 Phase S — Consensus hardening regression tests.
 *
 * SA-06: consensus majority ending incomplete -> cannot silver PASS.
 * SA-07: consensus start incomplete AND context dependent -> cannot PASS.
 * SA-08: provider/parse judge failure -> no fabricated label.
 * SA-22: REVIEW candidates are never counted as PASS.
 */
import { describe, expect, it } from 'vitest';
import {
  decideConsensusV13,
  vetoReasonOf,
} from '../consensus-v2';
import type { JudgeCall, JudgeTier } from '@/lib/v12r/judge-types';

function okCall(
  tier: JudgeTier,
  overrides: Partial<JudgeCall['output'] & Record<string, unknown>> = {},
): JudgeCall {
  return {
    tier,
    providerId: 'test',
    model: 'test-model',
    raw_text: '{}',
    output: {
      start_complete: true,
      setup_sufficient: true,
      context_independence: true,
      hook_score: 0.7,
      topic_cohesion: 0.7,
      payoff_score: 0.7,
      ending_complete: true,
      next_topic_leakage: false,
      hard_negative: false,
      standalone_score: 0.7,
      publishable: true,
      confidence: 0.9,
      failure_reasons: [],
      repair_hint: { action: 'NONE', directional_seconds: 0, semantic_reason: '' },
      short_reason: '',
      ...overrides,
    } as JudgeCall['output'],
    status: 'ok',
    error: null,
    attempts: 1,
    input_tokens: 10,
    output_tokens: 10,
    duration_ms: 5,
  };
}

function failCall(tier: JudgeTier, status: JudgeCall['status'], error = 'boom'): JudgeCall {
  return {
    tier,
    providerId: 'test',
    model: 'test-model',
    raw_text: '',
    output: null,
    status,
    error,
    attempts: 1,
    input_tokens: null,
    output_tokens: null,
    duration_ms: 5,
  };
}

describe('V13 consensus hardening (SA-06/SA-07/SA-08/SA-22)', () => {
  it('SA-06: majority ending_complete=false cannot PASS even when publishable=true', () => {
    const a = okCall('A', { publishable: true, confidence: 0.9, ending_complete: false });
    const b = okCall('B', { publishable: true, confidence: 0.9, ending_complete: false });
    const result = decideConsensusV13(a, b, null);
    expect(result.decision.label).toBe('REVIEW');
    expect(result.decision.rule).toBe('V13_CRITICAL_VETO');
    expect(result.veto_reason).toContain('ending_complete=false');
  });

  it('SA-06b: single judge ending_complete=false on 2-of-3 needs C; majority veto only with 2 flags', () => {
    const a = okCall('A', { publishable: true, ending_complete: false });
    const b = okCall('B', { publishable: true, ending_complete: true });
    const c = okCall('C', { publishable: true, ending_complete: true });
    const result = decideConsensusV13(a, b, c);
    // 2-of-3 publishable, only 1 flag -> PASS allowed (no majority veto).
    expect(result.decision.label).toBe('PASS');
  });

  it('SA-07: majority start_complete=false AND context_independence=false blocks PASS', () => {
    const a = okCall('A', { publishable: true, start_complete: false, context_independence: false });
    const b = okCall('B', { publishable: true, start_complete: false, context_independence: false });
    const result = decideConsensusV13(a, b, null);
    expect(result.decision.label).toBe('REVIEW');
    expect(result.veto_reason).toContain('start_complete=false && context_independence=false');
  });

  it('SA-07b: start_complete=false ALONE (context independent) is not a veto', () => {
    const a = okCall('A', { publishable: true, start_complete: false, context_independence: true });
    const b = okCall('B', { publishable: true, start_complete: false, context_independence: true });
    const result = decideConsensusV13(a, b, null);
    expect(result.decision.label).toBe('PASS');
    expect(vetoReasonOf(a, b, null)).toBeNull();
  });

  it('SA-08: provider failure yields REVIEW, never PASS/FAIL', () => {
    const a = okCall('A', { publishable: true });
    const b = failCall('B', 'provider_error');
    const result = decideConsensusV13(a, b, null);
    expect(result.decision.label).toBe('REVIEW');
    expect(result.decision.rule).toMatch(/INCOMPLETE_VOTES|REVIEW/i);
  });

  it('SA-08b: unanimous FAIL with a failed judge stays FAIL (only when remaining unanimous)', () => {
    // B is missing but A alone cannot decide FAIL; 2-of-3 requires C.
    const a = okCall('A', { publishable: false, confidence: 0.9 });
    const c = okCall('C', { publishable: false, confidence: 0.9 });
    const result = decideConsensusV13(a, failCall('B', 'provider_error'), c);
    expect(result.decision.label).toBe('FAIL');
  });

  it('SA-22: 2-of-3 PASS with majority next_topic_leakage/hard_negative cannot PASS', () => {
    const a = okCall('A', { publishable: true, hard_negative: true });
    const b = okCall('B', { publishable: true });
    const c = okCall('C', { publishable: false });
    const result = decideConsensusV13(a, b, c);
    expect(result.decision.label).toBe('REVIEW');
  });

  it('clean AB consensus PASS is preserved', () => {
    const a = okCall('A', { publishable: true });
    const b = okCall('B', { publishable: true });
    const result = decideConsensusV13(a, b, null);
    expect(result.decision.label).toBe('PASS');
    expect(result.veto_reason).toBeNull();
  });

  it('unanimous FAIL is preserved under hardening', () => {
    const a = okCall('A', { publishable: false, confidence: 0.9, end_complete: false });
    const b = okCall('B', { publishable: false, confidence: 0.9 });
    const result = decideConsensusV13(a, b, null);
    expect(result.decision.label).toBe('FAIL');
  });
});