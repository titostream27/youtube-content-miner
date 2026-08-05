import { describe, it, expect } from 'vitest';
import {
  evaluateGolden,
  topKRecall,
  topKRankAwareRecall,
  boundaryError,
  contaminationError,
  binaryAccuracy,
  matchByTemporalIoU,
  temporalIoU,
  type GoldenLabel,
  type Prediction,
} from '@/lib/golden/metrics';
import { GOLDEN_FIXTURES } from '@/lib/golden/fixtures';

describe('golden metrics (Phase 2 golden dataset)', () => {
  const labels: GoldenLabel[] = [
    { clipId: 'a', expectedScore: 95, expectedStartSec: 10, expectedEndSec: 20, expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
    { clipId: 'b', expectedScore: 80, expectedStartSec: 30, expectedEndSec: 40, expectedContamination: 0.1, expectedStartComplete: true, expectedEndingComplete: true },
    { clipId: 'c', expectedScore: 60, expectedStartSec: 50, expectedEndSec: 60, expectedContamination: 0.2, expectedStartComplete: false, expectedEndingComplete: true },
  ];

  it('computes plain top-k recall', () => {
    const preds: Prediction[] = [
      { clipId: 'a', score: 90, startSec: 10, endSec: 20, contamination: 0.05, startComplete: true, endingComplete: true },
      { clipId: 'c', score: 70, startSec: 50, endSec: 60, contamination: 0.2, startComplete: false, endingComplete: true },
      { clipId: 'b', score: 65, startSec: 30, endSec: 40, contamination: 0.1, startComplete: true, endingComplete: true },
    ];
    // Top-2 labels = [a, b]; predicted top-2 = [a, c] -> 1/2 hit.
    expect(topKRecall(labels, preds, 2)).toBe(0.5);
  });

  it('computes rank-aware recall (rewards position)', () => {
    const perfect: Prediction[] = [
      { clipId: 'a', score: 99, startSec: 10, endSec: 20, contamination: 0.05, startComplete: true, endingComplete: true },
      { clipId: 'b', score: 88, startSec: 30, endSec: 40, contamination: 0.1, startComplete: true, endingComplete: true },
    ];
    const swapped: Prediction[] = [
      { clipId: 'b', score: 99, startSec: 30, endSec: 40, contamination: 0.1, startComplete: true, endingComplete: true },
      { clipId: 'a', score: 88, startSec: 10, endSec: 20, contamination: 0.05, startComplete: true, endingComplete: true },
    ];
    expect(topKRankAwareRecall(labels, perfect, 2)).toBe(1);
    expect(topKRankAwareRecall(labels, swapped, 2)).toBeLessThan(1);
  });

  it('computes mean boundary error in seconds', () => {
    const preds: Prediction[] = [
      { clipId: 'a', score: 90, startSec: 12, endSec: 21, contamination: 0.05, startComplete: true, endingComplete: true },
      { clipId: 'b', score: 80, startSec: 31, endSec: 41, contamination: 0.1, startComplete: true, endingComplete: true },
    ];
    const { start, end } = boundaryError(preds, labels);
    expect(start).toBe(1.5);
    expect(end).toBe(1);
  });

  it('computes mean contamination error', () => {
    const preds: Prediction[] = [
      { clipId: 'a', score: 90, startSec: 10, endSec: 20, contamination: 0.3, startComplete: true, endingComplete: true },
    ];
    expect(contaminationError(preds, labels)).toBe(0.25);
  });

  it('computes binary accuracy for start/end completeness', () => {
    const preds: Prediction[] = [
      { clipId: 'a', score: 90, startSec: 10, endSec: 20, contamination: 0.05, startComplete: true, endingComplete: true },
      { clipId: 'c', score: 60, startSec: 50, endSec: 60, contamination: 0.2, startComplete: true, endingComplete: true }, // startComplete mismatch
    ];
    expect(
      binaryAccuracy(preds, labels, (p, l) => p.startComplete === l.expectedStartComplete),
    ).toBe(0.5);
  });

  it('evaluateGolden returns a complete metrics bundle', () => {
    const preds: Prediction[] = GOLDEN_FIXTURES[0]!.labels.map((l) => ({
      clipId: l.clipId,
      score: l.expectedScore,
      startSec: l.expectedStartSec,
      endSec: l.expectedEndSec,
      contamination: l.expectedContamination,
      startComplete: l.expectedStartComplete,
      endingComplete: l.expectedEndingComplete,
    }));
    const m = evaluateGolden(GOLDEN_FIXTURES[0]!.labels, preds, GOLDEN_FIXTURES[0]!.topK);
    expect(m.n).toBe(3);
    expect(m.topKRecall).toBe(1);
    expect(m.topKRankAwareRecall).toBe(1);
    expect(m.meanBoundaryStartErrorSec).toBe(0);
    expect(m.meanBoundaryEndErrorSec).toBe(0);
    expect(m.meanContaminationError).toBe(0);
    expect(m.startCompleteAccuracy).toBe(1);
    expect(m.endingCompleteAccuracy).toBe(1);
  });

  it('golden fixtures have consistent cue ordering and in-range labels', () => {
    for (const fx of GOLDEN_FIXTURES) {
      for (let i = 1; i < fx.transcriptCues.length; i += 1) {
        expect(fx.transcriptCues[i]!.startSec).toBeGreaterThanOrEqual(fx.transcriptCues[i - 1]!.endSec);
      }
      for (const label of fx.labels) {
        expect(label.expectedEndSec).toBeGreaterThan(label.expectedStartSec);
        expect(label.expectedContamination).toBeGreaterThanOrEqual(0);
        expect(label.expectedContamination).toBeLessThanOrEqual(1);
      }
    }
  });

  // ── Phase-2 F22: temporal-IoU matching ───────────────────────────────────
  it('matches predictions to labels by temporal IoU, not clipId', () => {
    expect(temporalIoU(0, 10, 2, 12)).toBeCloseTo(8 / 12, 5);
    expect(temporalIoU(0, 10, 20, 30)).toBe(0);
    // Different ids, overlapping windows -> matched.
    const matches = matchByTemporalIoU(
      [{ clipId: 'label-x', expectedScore: 90, expectedStartSec: 10, expectedEndSec: 30, expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true }],
      [{ clipId: 'pred-y', score: 85, startSec: 12, endSec: 28, contamination: 0.05, startComplete: true, endingComplete: true }],
      0.5,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.pred).not.toBeNull();
  });

  it('evaluateGolden reports temporal recall on the second fixture', () => {
    const fx = GOLDEN_FIXTURES[1]!;
    // Predictions that overlap the labeled windows (ids intentionally differ).
    const preds: Prediction[] = [
      { clipId: 'q1', score: 91, startSec: 16, endSec: 27, contamination: 0.03, startComplete: true, endingComplete: true },
      { clipId: 'q2', score: 83, startSec: 33, endSec: 45, contamination: 0.02, startComplete: true, endingComplete: true },
      { clipId: 'q3', score: 74, startSec: 22, endSec: 33, contamination: 0.06, startComplete: true, endingComplete: true },
    ];
    const m = evaluateGolden(fx.labels, preds, fx.topK);
    expect(m.n).toBe(3);
    expect(m.temporalRecall).toBe(1);
    expect(m.meanTemporalIoU).toBeGreaterThan(0.5);
  });
});
