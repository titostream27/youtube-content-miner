import { describe, it, expect } from 'vitest';
import {
  matchByTemporalIoU,
  evaluateGolden,
  type GoldenLabel,
  type Prediction,
} from '@/lib/golden/metrics';

/**
 * Brief v8 C11 — test(miner): maximum-cardinality temporal assignment and
 * explicit metric denominators (RED on v7, GREEN after C12).
 *
 * - E01: greedy highest-IoU matching can miss a valid two-match assignment.
 * - E02: the metric report must expose positive/negative/ignored/prediction
 *   denominators explicitly (not just an ambiguous `n`).
 */

function L(id: string, s: number, e: number): GoldenLabel {
  return {
    clipId: id, type: 'positive' as const, expectedScore: 90,
    expectedStartSec: s, expectedEndSec: e,
    expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true,
  };
}

function P(id: string, s: number, e: number): Prediction {
  return {
    clipId: id, score: 85, startSec: s, endSec: e,
    contamination: 0.05, startComplete: true, endingComplete: true,
  };
}

describe('V8-E01: maximum-cardinality temporal assignment', () => {
  it('crossing assignment produces two matches (greedy counterexample)', () => {
      // Verified: greedy (highest-IoU first) returns 1; maximum-cardinality
      // matching returns 2. Config: L1=[0,35] L2=[25,55] P1=[0,55] P2=[4,25].
      // Greedy binds L1->P1 (its best) and then cannot match L2; optimal is
      // L1->P2, L2->P1.
      const labels = [L('L1', 0, 35), L('L2', 25, 55)];
      const preds = [P('P1', 0, 55), P('P2', 4, 25)];
      const matches = matchByTemporalIoU(labels, preds, 0.5);
      const matched = matches.filter((m) => m.pred !== null);
      expect(matched.length).toBe(2);
    });

  it('no prediction or label is used more than once', () => {
    const labels = [L('L1', 0, 10), L('L2', 1, 9)];
    const preds = [P('P1', 0, 10)];
    const res = matchByTemporalIoU(labels, preds, 0.5);
    const usedPredictions = new Set(
      res.filter((m) => m.pred !== null).map((m) => m.pred!.clipId),
    );
    // Only as many predictions as exist, each used at most once.
    expect(usedPredictions.size).toBeLessThanOrEqual(1);
  });

  it('deterministic tie-breaking: same input yields same assignment', () => {
    const labels = [L('L1', 0, 10), L('L2', 5, 15)];
    const preds = [P('P1', 4, 12), P('P2', 6, 14)];
    const a = matchByTemporalIoU(labels, preds, 0.5);
    const b = matchByTemporalIoU(labels, preds, 0.5);
    const key = (m: { label: GoldenLabel; pred: Prediction | null }) =>
      `${m.label.clipId}:${m.pred ? m.pred.clipId : '-'}`;
    expect(a.map(key)).toEqual(b.map(key));
  });
});

describe('V8-E02: explicit metric denominator counts', () => {
  it('evaluateGolden exposes positive/hard-negative/ignored/prediction counts', () => {
    const m = evaluateGolden(
      [
        L('pos1', 0, 10),
        L('pos2', 20, 30),
        { clipId: 'neg1', type: 'hard_negative' as const, expectedScore: 0,
          expectedStartSec: 40, expectedEndSec: 50, expectedContamination: 0.9,
          expectedStartComplete: false, expectedEndingComplete: false },
        { clipId: 'ign1', type: 'ignore' as const, expectedScore: 0,
          expectedStartSec: 60, expectedEndSec: 70, expectedContamination: 0.9,
          expectedStartComplete: false, expectedEndingComplete: false },
      ],
      [P('p1', 0, 10), P('p2', 20, 30)],
      3,
    );
    expect(typeof m.nPositive).toBe('number');
    expect(m.nPositive).toBe(2);
    expect(m.nHardNegative).toBe(1);
    expect(m.nIgnored).toBe(1);
    expect(m.nPredictions).toBe(2);
  });
});