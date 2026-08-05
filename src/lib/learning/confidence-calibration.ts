/**
 * Phase 2 (Confidence calibration) — measure whether predicted confidence
 * actually predicts editor acceptance and boundary accuracy.
 *
 * The system already emits a confidence per clip (0-100). This module turns
 * the editor's labelled decisions (clip_feedback + clip_feedback_boundary)
 * into calibration statistics:
 *
 *   - acceptanceRate(confidenceBucket): of clips predicted in bucket B, how
 *     many were approved by the editor.
 *   - boundaryError(bucket): mean |original - new| boundary shift for clips
 *     the editor manually corrected, grouped by the ORIGINAL confidence.
 *   - calibrationError: ECE-style |confidence - acceptance| averaged over
 *     buckets (weighted by bucket size).
 *
 * A well-calibrated system: buckets with higher predicted confidence show
 * monotonically higher acceptance and lower boundary error. When the curve
 * is flat or inverted, confidence is not calibrated and the UI should show a
 * warning instead of trusting the tier label.
 */

export type EditorVerdict = 'approved' | 'rejected' | 'boundary_adjusted';

export interface FeedbackSample {
  clipId: number;
  confidence: number; // 0-100 predicted at clip creation
  verdict: EditorVerdict;
  /** Boundary shift in seconds (0 when not boundary-adjusted). */
  boundaryShiftSec: number;
}

export interface CalibrationBucket {
  bucket: string;
  min: number;
  max: number;
  n: number;
  acceptanceRate: number; // 0-1
  meanBoundaryShiftSec: number;
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  /** ECE-style error 0-1 (0 = perfectly calibrated). */
  calibrationError: number;
  /** Number of labelled samples seen so far. */
  n: number;
  /** True when there are enough samples to trust the report. */
  sufficientData: boolean;
  /** Qualitative read of the curve. */
  assessment: 'well_calibrated' | 'needs_data' | 'overconfident' | 'underconfident' | 'unstable';
}

const BUCKETS: { min: number; max: number; label: string }[] = [
  { min: 0, max: 39, label: '0-39' },
  { min: 40, max: 59, label: '40-59' },
  { min: 60, max: 74, label: '60-74' },
  { min: 75, max: 89, label: '75-89' },
  { min: 90, max: 100, label: '90-100' },
];

const MIN_SAMPLES_PER_BUCKET = 3;
const MIN_TOTAL_SAMPLES = 10;

export function calibrateConfidence(samples: FeedbackSample[]): CalibrationReport {
  const buckets = BUCKETS.map((b) => {
    const inBucket = samples.filter((s) => s.confidence >= b.min && s.confidence <= b.max);
    const approved = inBucket.filter((s) => s.verdict === 'approved').length;
    const adjusted = inBucket.filter((s) => s.verdict === 'boundary_adjusted').length;
    return {
      bucket: b.label,
      min: b.min,
      max: b.max,
      n: inBucket.length,
      acceptanceRate: inBucket.length === 0 ? 0 : approved / inBucket.length,
      meanBoundaryShiftSec:
        adjusted === 0
          ? 0
          : round2(
              inBucket
                .filter((s) => s.verdict === 'boundary_adjusted')
                .reduce((a, s) => a + s.boundaryShiftSec, 0) / adjusted,
            ),
    };
  });

  // Weighted calibration error: mean |expected acceptance - observed| where
  // expected = bucket midpoint / 100 (our confidence as a probability).
  const populated = buckets.filter((b) => b.n > 0);
  const totalN = populated.reduce((a, b) => a + b.n, 0);
  const calibrationError =
    totalN === 0
      ? 0
      : round2(
          populated.reduce((acc, b) => {
            const expected = ((b.min + b.max) / 2) / 100;
            return acc + (b.n / totalN) * Math.abs(expected - b.acceptanceRate);
          }, 0),
        );

  const sufficientData = samples.length >= MIN_TOTAL_SAMPLES &&
    populated.filter((b) => b.n >= MIN_SAMPLES_PER_BUCKET).length >= 2;

  const assessment = assess(samples, populated, sufficientData);

  return {
    buckets,
    calibrationError,
    n: samples.length,
    sufficientData,
    assessment,
  };
}

function assess(
  samples: FeedbackSample[],
  populated: CalibrationBucket[],
  sufficient: boolean,
): CalibrationReport['assessment'] {
  if (!sufficient || samples.length === 0) return 'needs_data';
  const filled = populated.filter((b) => b.n > 0);
  if (filled.length < 2) return 'needs_data';

  const sorted = filled.slice().sort((a, b) => a.min - b.min);
  let monotonicUp = true;
  let monotonicDown = true;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.acceptanceRate < sorted[i - 1]!.acceptanceRate - 0.05) monotonicUp = false;
    if (sorted[i]!.acceptanceRate > sorted[i - 1]!.acceptanceRate + 0.05) monotonicDown = false;
  }

  if (monotonicUp) {
    // High buckets accepted >= 70% of the time?
    const top = sorted[sorted.length - 1]!;
    return top.acceptanceRate >= 0.7 ? 'well_calibrated' : 'underconfident';
  }
  if (monotonicDown) return 'overconfident';
  return 'unstable';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
