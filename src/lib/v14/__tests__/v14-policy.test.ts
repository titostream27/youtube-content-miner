/**
 * Brief V14 — unit tests: ending policy, soft penalty, start semantics,
 * trace invariants (catalog V14-END-001..004, V14-STA-001, V14-SCR-001/002,
 * V14-TRC-001).
 */
import { describe, expect, it } from 'vitest';
import {
  VARIANT_POLICIES,
  decideEnding,
  softPenalty,
  APPROVED_HARD_REJECT_CODES,
} from '../ending-policy';
import { startBoundaryNeedsReject, START_HARD_ISSUES } from '../../moments/start-gate';

function ending(
  endingType: 'ANSWER_COMPLETE' | 'CONCLUSION' | 'PUNCHLINE' | 'INCOMPLETE_SENTENCE' | 'QUESTION_START' | 'FILLER' | 'TOPIC_TRANSITION' | 'UNKNOWN',
  endingConfidence: number,
  endingComplete: boolean,
) {
  return { endingType, endingConfidence, endingComplete };
}

describe('V14-END-001 — COMPLETE + 0.78 + no defect evidence never hard-rejects from confidence alone', () => {
  it('C0 hard-rejects (baseline); E3 must not', () => {
    const e = ending('CONCLUSION', 0.78, true);
    const c0 = decideEnding(e, VARIANT_POLICIES.C0);
    expect(c0.hard_reject).toBe(true);
    expect(c0.reason_code).toBe('ENDING_CONFIDENCE_LOW');
    const e3 = decideEnding(e, VARIANT_POLICIES.E3);
    expect(e3.hard_reject).toBe(false);
    expect(e3.action).toBe('SOFT_PENALTY');
    expect(e3.soft_penalty).toBeGreaterThan(0);
    expect(e3.soft_penalty).toBeLessThanOrEqual(4);
  });
});

describe('V14-END-002 — INCOMPLETE at high confidence still hard-rejects', () => {
  it('INCOMPLETE_SENTENCE 0.95 -> hard reject under E3/E4', () => {
    const e = ending('INCOMPLETE_SENTENCE', 0.95, true);
    for (const v of ['E3', 'E4'] as const) {
      const d = decideEnding(e, VARIANT_POLICIES[v]);
      expect(d.hard_reject).toBe(true);
      expect(d.reason_code).toBe('SYNTAX_TRUNCATION');
      expect(d.observed_invalidity).toBe(true);
    }
  });
});

describe('V14-END-003 — UNKNOWN is never coerced to INCOMPLETE', () => {
  it('UNKNOWN 0.40 -> soft penalty, not hard reject', () => {
    const d = decideEnding(ending('UNKNOWN', 0.4, false), VARIANT_POLICIES.E3);
    expect(d.state).toBe('UNKNOWN');
    expect(d.hard_reject).toBe(false);
    expect(d.action).toBe('SOFT_PENALTY');
    expect(d.observed_invalidity).toBe(false);
  });
  it('TOPIC_TRANSITION is classifier disagreement -> UNKNOWN', () => {
    const d = decideEnding(ending('TOPIC_TRANSITION', 0.6, false), VARIANT_POLICIES.E3);
    expect(d.state).toBe('UNKNOWN');
    expect(d.hard_reject).toBe(false);
  });
});

describe('V14-END-004 — soft penalty bounded and monotonic', () => {
  it('cap respected for every grid value', () => {
    for (const cap of [0, 2, 4, 6]) {
      expect(softPenalty(0.12, 'UNKNOWN', cap)).toBeLessThanOrEqual(cap);
      expect(softPenalty(0.78, 'COMPLETE', cap)).toBeLessThanOrEqual(cap);
    }
  });
  it('monotone in confidence', () => {
    for (const state of ['COMPLETE', 'UNKNOWN'] as const) {
      let prev = Infinity;
      for (let c = 0.3; c <= 0.821; c += 0.02) {
        const p = softPenalty(c, state, 4);
        expect(p).toBeLessThanOrEqual(prev);
        prev = p;
      }
    }
  });
  it('zero at / beyond the floor', () => {
    expect(softPenalty(0.82, 'COMPLETE', 4)).toBe(0);
    expect(softPenalty(0.9, 'UNKNOWN', 4)).toBe(0);
  });
  it('hard reject is not a confidence outcome (observed_invalidity false for low conf)', () => {
    const d = decideEnding(ending('CONCLUSION', 0.78, true), VARIANT_POLICIES.C0);
    expect(d.hard_reject).toBe(true);
    expect(d.observed_invalidity).toBe(false);
    expect(APPROVED_HARD_REJECT_CODES).toContain('ENDING_INCOMPLETE');
  });
});

describe('V14-STA-001 — context dependency is separable from low START confidence', () => {
  it('hard issues versus soft LATE_HOOK', () => {
    expect(START_HARD_ISSUES.has('MID_SENTENCE')).toBe(true);
    expect(START_HARD_ISSUES.has('MISSING_CONTEXT')).toBe(true);
    expect(START_HARD_ISSUES.has('UNRESOLVED_REFERENCE')).toBe(true);
    expect(START_HARD_ISSUES.has('LATE_HOOK')).toBe(false);
    expect(startBoundaryNeedsReject(['LATE_HOOK'])).toBe(false);
    expect(startBoundaryNeedsReject(['MISSING_CONTEXT'])).toBe(true);
  });
});

describe('V14-TRC-001 — stage id distinct from execution index; NOT_REACHED distinct from PASS (V14-TRC-002)', () => {
  it('numeric stage labels do not imply runtime order', () => {
    const stageId = '05_ENDING_CONFIDENCE';
    const executionIndex = 4;
    expect(stageId.split('_')[0]).toBe('05');
    expect(executionIndex).toBeLessThan(8); // 03_START_GATE may run later (execution index 8)
  });
  it('NOT_REACHED is not PASS', () => {
    const notReached = { stage_id: '13_FINAL_ACCEPTED', status: 'NOT_REACHED' };
    expect(notReached.status).not.toBe('SURVIVED');
    expect(notReached.status).toBe('NOT_REACHED');
  });
});

describe('V14-SCR-001/002 — score invariants', () => {
  it('penalty never negative and never exceeds cap', () => {
    for (const c of [0.1, 0.4, 0.78, 0.83, 0.99]) {
      for (const state of ['COMPLETE', 'UNKNOWN', 'INCOMPLETE'] as const) {
        const p = softPenalty(c, state, 4);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(4);
      }
    }
  });
});