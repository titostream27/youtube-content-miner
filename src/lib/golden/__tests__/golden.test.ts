import { describe, it, expect } from 'vitest';
import {
  evaluateGolden,
  boundaryError,
  contaminationError,
  binaryAccuracy,
  matchByTemporalIoU,
  boundaryErrorFromMatches,
  contaminationErrorFromMatches,
  binaryAccuracyFromMatches,
  topKRecall,
  topKRankAwareRecall,
  temporalIoU,
  computeAssignmentResult,
  type GoldenLabel,
  type Prediction,
} from '@/lib/golden/metrics';
import { GOLDEN_FIXTURES } from '@/lib/golden/fixtures';

describe('golden dataset coverage (hardening v3 F3 matrix)', () => {
  it('covers both languages and both caption quality levels', () => {
    const langs = new Set(GOLDEN_FIXTURES.map((f) => f.language));
    const qualities = new Set(GOLDEN_FIXTURES.map((f) => f.captionsQuality));
    expect(langs.has('en')).toBe(true);
    expect(langs.has('id')).toBe(true);
    expect(qualities.has('clean')).toBe(true);
    expect(qualities.has('noisy')).toBe(true);
  });

  it('has at least one multi-speaker and one hard-negative fixture', () => {
    expect(GOLDEN_FIXTURES.length).toBeGreaterThanOrEqual(5);
    const hardNegatives = GOLDEN_FIXTURES.flatMap((f) => f.labels)
      .filter((l) => l.expectedScore < 60 || l.expectedContamination > 0.5);
    expect(hardNegatives.length).toBeGreaterThan(0);
  });
});

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

  // ── Hardening v3 F2 (#32): all boundary metrics share ONE temporal
  // assignment — no metric silently falls back to clipId-positional maps ────
  it('boundary metrics use the COMMON temporal assignment, not clipId maps', () => {
    const labels = [
      { clipId: 'label-x', expectedScore: 90, expectedStartSec: 10, expectedEndSec: 30,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
    ];
    const preds: Prediction[] = [
      { clipId: 'pred-y', score: 85, startSec: 12, endSec: 28, contamination: 0.05,
        startComplete: true, endingComplete: true },
    ];
    const m = evaluateGolden(labels, preds, 1);
    expect(m.temporalRecall).toBeCloseTo(1, 5);
    expect(m.meanBoundaryStartErrorSec).toBeCloseTo(2, 5);
    expect(m.meanBoundaryEndErrorSec).toBeCloseTo(2, 5);
    expect(m.startCompleteAccuracy).toBe(1);
    const matches = matchByTemporalIoU(labels, preds, 0.5);
    expect(boundaryErrorFromMatches(matches).start).toBeCloseTo(2, 5);
    expect(contaminationErrorFromMatches(matches)).toBe(0);
    expect(binaryAccuracyFromMatches(matches, (p, l) => p.startComplete === l.expectedStartComplete)).toBe(1);
  });

  // ── Brief v4 D1 (#8): crossing temporal assignment must match BOTH ───────
  it('crossing assignment label0->pred1 and label1->pred0 matches both (D1)', () => {
    const labels = [
      { clipId: 'l0', expectedScore: 90, expectedStartSec: 10, expectedEndSec: 20,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
      { clipId: 'l1', expectedScore: 80, expectedStartSec: 30, expectedEndSec: 40,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
    ];
    const preds: Prediction[] = [
      // pred0 overlaps label1 only; pred1 overlaps label0 only.
      { clipId: 'p0', score: 85, startSec: 31, endSec: 39, contamination: 0.05, startComplete: true, endingComplete: true },
      { clipId: 'p1', score: 82, startSec: 11, endSec: 19, contamination: 0.05, startComplete: true, endingComplete: true },
    ];
    const matches = matchByTemporalIoU(labels, preds, 0.5);
    // Both labels matched; the old single-Set implementation would skip the
    // second pair because it reused indices (0 and 1 collided).
    expect(matches.filter((m) => m.pred !== null)).toHaveLength(2);
  });

  it('one prediction cannot match two labels (D1)', () => {
    const labels = [
      { clipId: 'l0', expectedScore: 90, expectedStartSec: 10, expectedEndSec: 20,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
      { clipId: 'l1', expectedScore: 80, expectedStartSec: 12, expectedEndSec: 22,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
    ];
    const preds: Prediction[] = [
      { clipId: 'p0', score: 85, startSec: 13, endSec: 19, contamination: 0.05, startComplete: true, endingComplete: true },
    ];
    const matches = matchByTemporalIoU(labels, preds, 0.5);
    const matched = matches.filter((m) => m.pred !== null);
    expect(matched.length).toBe(1);
  });

  // ── Brief v4 D2 (#9): label types ────────────────────────────────────────
  it('hard negatives and ignores are not counted as recall positives (D2)', () => {
    const labels = [
      { clipId: 'pos', type: 'positive' as const, expectedScore: 90, expectedStartSec: 10, expectedEndSec: 20,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
      { clipId: 'neg', type: 'hard_negative' as const, expectedScore: 0, expectedStartSec: 30, expectedEndSec: 40,
        expectedContamination: 0.95, expectedStartComplete: false, expectedEndingComplete: false },
    ];
    const preds: Prediction[] = [
      { clipId: 'p0', score: 85, startSec: 11, endSec: 19, contamination: 0.05, startComplete: true, endingComplete: true },
    ];
    const m = evaluateGolden(labels, preds, 2);
    // Positive matched -> recall counts it; hard negative has no pred and
    // must NOT inflate recall either (only positive labels are in the
    // denominator of positive recall).
    expect(m.temporalRecall).toBeCloseTo(1, 5);
    expect(m.n).toBe(2);
  });

  // ── Brief v7 E01: hard-negative FPR is a bounded rate ──
  it('hardNegativeFPR is a rate in [0,1], not an overlap count (E01)', () => {
    // One hard-negative label hit by THREE predictions must yield FPR = 1.0
    // (the label is hit), NOT 3.0 (the raw overlap count).
    const labels = [
      { clipId: 'pos', type: 'positive' as const, expectedScore: 90, expectedStartSec: 10, expectedEndSec: 20,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
      { clipId: 'neg', type: 'hard_negative' as const, expectedScore: 0, expectedStartSec: 30, expectedEndSec: 33,
        expectedContamination: 0.95, expectedStartComplete: false, expectedEndingComplete: false },
    ];
    const preds: Prediction[] = [
      { clipId: 'p0', score: 85, startSec: 30, endSec: 32.5, contamination: 0.9, startComplete: false, endingComplete: false },
      { clipId: 'p1', score: 80, startSec: 30, endSec: 33, contamination: 0.9, startComplete: false, endingComplete: false },
      { clipId: 'p2', score: 75, startSec: 30.5, endSec: 33, contamination: 0.9, startComplete: false, endingComplete: false },
    ];
    const m = evaluateGolden(labels, preds, 3);
    // Raw overlap count = 3; rate must be bounded by the number of negatives.
    expect(m.hardNegativeFalsePositives).toBe(3);
    expect(m.hardNegativeFPR).toBeLessThanOrEqual(1);
    expect(m.hardNegativeFPR).toBeCloseTo(1, 5);
  });

  // ── Brief v5 G-01: positive and hard-negative evaluated independently ──
  it('a prediction overlapping BOTH positive and hard negative reports both (G-01)', () => {
    const labels = [
      { clipId: 'pos', type: 'positive' as const, expectedScore: 90, expectedStartSec: 10, expectedEndSec: 20,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
      { clipId: 'neg', type: 'hard_negative' as const, expectedScore: 0, expectedStartSec: 15, expectedEndSec: 25,
        expectedContamination: 0.9, expectedStartComplete: false, expectedEndingComplete: false },
    ];
    const preds: Prediction[] = [
      { clipId: 'p0', score: 85, startSec: 12, endSec: 22, contamination: 0.1, startComplete: true, endingComplete: true },
    ];
    const a = computeAssignmentResult(labels, preds, 0.5);
    // Same prediction matches the positive AND overlaps the hard negative.
    expect(a.positive_matches).toHaveLength(1);
    expect(a.hard_negative_overlaps).toHaveLength(1);
    expect(a.hard_negative_overlaps[0]!.predictionId).toBe('p0');
  });

  // ── Brief v5 G-02: rank-aware metrics use LABEL expected rank ───────────
  it('rank-aware recall iterates labels by expected rank, not assignment order (G-02)', () => {
    // label1 has the HIGHEST expected score; label0 lower.
    const labels = [
      { clipId: 'l0', expectedScore: 70, expectedStartSec: 10, expectedEndSec: 20,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
      { clipId: 'l1', expectedScore: 95, expectedStartSec: 30, expectedEndSec: 40,
        expectedContamination: 0.05, expectedStartComplete: true, expectedEndingComplete: true },
    ];
    // The best prediction matches l1 at rank 0 — full credit for label rank 0.
    const preds: Prediction[] = [
      { clipId: 'p1', score: 95, startSec: 31, endSec: 39, contamination: 0.05, startComplete: true, endingComplete: true },
      { clipId: 'p0', score: 60, startSec: 11, endSec: 19, contamination: 0.05, startComplete: true, endingComplete: true },
    ];
    const k = 2;
    // label1 (rank 0) is matched by p1 (rank 0): credit = 1/(1+0) = 1.
    // label0 (rank 1) is matched by p0 (rank 1): credit = 1/(1+0) = 1.
    const r = topKRankAwareRecall(labels, preds, k);
    expect(r).toBeCloseTo(1, 5);
  });
});
