import { describe, it, expect } from 'vitest';
import { calibrateConfidence, type FeedbackSample } from '@/lib/learning/confidence-calibration';

function sample(confidence: number, verdict: FeedbackSample['verdict'], boundaryShiftSec = 0): FeedbackSample {
  return { clipId: Math.random(), confidence, verdict, boundaryShiftSec };
}

describe('confidence calibration (Phase 2)', () => {
  it('needs_data when there are no samples', () => {
    const r = calibrateConfidence([]);
    expect(r.assessment).toBe('needs_data');
    expect(r.sufficientData).toBe(false);
    expect(r.n).toBe(0);
  });

  it('says needs_data with too few samples', () => {
    const r = calibrateConfidence([sample(90, 'approved'), sample(50, 'rejected')]);
    expect(r.assessment).toBe('needs_data');
  });

  it('reports well_calibrated when acceptance rises with confidence', () => {
    const samples: FeedbackSample[] = [
      ...Array.from({ length: 4 }, () => sample(30, 'rejected')),
      ...Array.from({ length: 4 }, () => sample(55, 'rejected')),
      ...Array.from({ length: 4 }, () => sample(70, 'approved')),
      ...Array.from({ length: 6 }, () => sample(95, 'approved')),
    ];
    const r = calibrateConfidence(samples);
    expect(r.sufficientData).toBe(true);
    expect(r.assessment).toBe('well_calibrated');
    expect(r.calibrationError).toBeLessThan(0.3);
    // Top bucket acceptance high.
    const top = r.buckets[r.buckets.length - 1]!;
    expect(top.acceptanceRate).toBe(1);
  });

  it('flags overconfident when high-confidence clips are rejected', () => {
    const samples: FeedbackSample[] = [
      ...Array.from({ length: 4 }, () => sample(90, 'rejected')),
      ...Array.from({ length: 4 }, () => sample(95, 'rejected')),
      ...Array.from({ length: 4 }, () => sample(50, 'approved')),
    ];
    const r = calibrateConfidence(samples);
    expect(r.sufficientData).toBe(true);
    expect(r.assessment).toBe('overconfident');
  });

  it('reports boundary shift per bucket for adjusted clips', () => {
    const samples: FeedbackSample[] = [
      sample(90, 'boundary_adjusted', 4.2),
      sample(90, 'boundary_adjusted', 3.8),
      sample(90, 'approved', 0),
    ];
    const r = calibrateConfidence(samples);
    const top = r.buckets[r.buckets.length - 1]!;
    expect(top.meanBoundaryShiftSec).toBeCloseTo(4.0, 1);
    expect(top.n).toBe(3);
  });
});
