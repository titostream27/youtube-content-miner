/**
 * Phase 2 (Golden dataset) — Measurable evaluation metrics.
 *
 * Golden fixtures carry a LABELED expected outcome. These functions turn a
 * pipeline prediction into the same units as the label so we can score the
 * system deterministically:
 *
 *   topKRecall      — how many of the top-K labeled clips appear in the
 *                     predicted top-K (rank-aware variant included).
 *   boundaryError   — mean |predicted - labeled| start/end in seconds.
 *   contaminationError — |predicted - labeled| next-topic contamination.
 *   startCompleteMatch — predicted startComplete == labeled.
 */

export interface GoldenLabel {
  clipId: string;
  /**
   * Brief v4 D2 (#9): label type. 'positive' = desired detection (counts
   * toward recall), 'hard_negative' = forbidden range (a prediction here is
   * a false positive and never helps recall), 'ignore' = excluded entirely.
   * Defaults to 'positive' for backward compatibility with existing fixtures.
   */
  type?: 'positive' | 'hard_negative' | 'ignore';
  /** 0-100 expected score (for ranking assertions). */
  expectedScore: number;
  expectedStartSec: number;
  expectedEndSec: number;
  /** Expected next-topic contamination 0-1. */
  expectedContamination: number;
  expectedStartComplete: boolean;
  expectedEndingComplete: boolean;
}

export interface Prediction {
  clipId: string;
  score: number;
  startSec: number;
  endSec: number;
  contamination: number;
  startComplete: boolean;
  endingComplete: boolean;
}

export interface GoldenMetrics {
  topKRecall: number;
  topKRankAwareRecall: number;
  meanBoundaryStartErrorSec: number;
  meanBoundaryEndErrorSec: number;
  meanContaminationError: number;
  startCompleteAccuracy: number;
  endingCompleteAccuracy: number;
  n: number;
  /** Phase-2 F22: recall@IoU>=threshold over temporal matches. */
  temporalRecall: number;
  meanTemporalIoU: number;
  /** Brief v4 D2 (#9): hard-negative false-positive rate and counts. */
  hardNegativeFPR: number;
  hardNegativeFalsePositives: number;
  ignoredLabels: number;
}

export function topKRecall(labels: GoldenLabel[], preds: Prediction[], k: number): number {
  // Brief v4 D3 (F21): top-K uses the SAME temporal assignment as recall —
  // a correct window with a DIFFERENT id still counts as a hit.
  const labelTop = labels
    .slice()
    .sort((a, b) => b.expectedScore - a.expectedScore)
    .slice(0, k);
  const predTop = preds
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  if (labelTop.length === 0) return 0;
  const matches = matchByTemporalIoU(labelTop, predTop, 0.5);
  const hit = matches.filter((m) => m.pred !== null).length;
  return hit / labelTop.length;
}

export function topKRankAwareRecall(labels: GoldenLabel[], preds: Prediction[], k: number): number {
  // Brief v5 8.2 (G-02): iterate labels by EXPECTED rank (not greedy
  // assignment order), then inspect the rank of the ASSIGNED prediction.
  const labelTop = labels
    .slice()
    .sort((a, b) => b.expectedScore - a.expectedScore)
    .slice(0, k);
  const predTop = preds
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  if (labelTop.length === 0) return 0;
  const assignment = computeAssignmentResult(labelTop, predTop, 0.5);
  const matchedByLabel = new Map<string, Prediction>();
  for (const pair of assignment.positive_pairs) {
    matchedByLabel.set(String(pair.label.clipId), pair.pred);
  }
  let sum = 0;
  for (const [rank, label] of labelTop.entries()) {
    const pred = matchedByLabel.get(String(label.clipId));
    if (!pred) continue;
    const idx = predTop.indexOf(pred);
    // Full credit at the label's expected rank, decaying as the matched
    // prediction falls further below it.
    sum += 1 / (1 + Math.abs(idx - rank));
  }
  return sum / labelTop.length;
}

/**
 * @deprecated Brief v6 8.3 (E03) — clipId-positional matching disagrees with
 * temporal assignment. Redirected to the canonical AssignmentResult: metrics
 * now use temporal IoU matching, not clipId equality.
 */
export function boundaryError(preds: Prediction[], labels: GoldenLabel[]): { start: number; end: number } {
  const a = computeAssignmentResult(labels, preds, 0.5);
  return boundaryErrorFromAssignment(a);
}

/**
 * @deprecated Brief v6 8.3 (E03) — redirected to assignment-based metrics.
 */
export function contaminationError(preds: Prediction[], labels: GoldenLabel[]): number {
  const a = computeAssignmentResult(labels, preds, 0.5);
  return contaminationErrorFromAssignment(a);
}

/**
 * @deprecated Brief v6 8.3 (E03) — redirected to assignment-based metrics.
 */
export function binaryAccuracy(
  preds: Prediction[],
  labels: GoldenLabel[],
  pick: (p: Prediction, l: GoldenLabel) => boolean,
): number {
  const a = computeAssignmentResult(labels, preds, 0.5);
  return binaryAccuracyFromAssignment(a, pick);
}

/** Temporal IoU of two [start, end) intervals (Phase-2 F22). */
export function temporalIoU(
  aStart: number, aEnd: number,
  bStart: number, bEnd: number,
): number {
  const inter = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const union = Math.max(0, Math.max(aEnd, bEnd) - Math.min(aStart, bStart));
  return union <= 0 ? 0 : inter / union;
}

/**
 * Phase-2 correctness (F22): match predictions to labels by temporal IoU
 * instead of by clipId. A prediction whose window overlaps a labeled window
 * by >= threshold is a true positive even if the id differs (the pipeline
 * assigns ids; the golden label describes a TIME WINDOW).
 */
export function matchByTemporalIoU(
  labels: GoldenLabel[],
  preds: Prediction[],
  threshold = 0.5,
): { label: GoldenLabel; pred: Prediction | null }[] {
  const result: { label: GoldenLabel; pred: Prediction | null }[] = [];
  // Greedy: highest-IoU assignment first, each label/pred used once.
  // Brief v4 D1 (#8): label and prediction indices live in SEPARATE
  // namespaces — a single Set<number> collides (label 0 and pred 0 are the
  // same number) and silently drops crossing assignments.
  const candidates: { li: number; pi: number; iou: number }[] = [];
  for (let li = 0; li < labels.length; li += 1) {
    for (let pi = 0; pi < preds.length; pi += 1) {
      const iou = temporalIoU(
        preds[pi]!.startSec, preds[pi]!.endSec,
        labels[li]!.expectedStartSec, labels[li]!.expectedEndSec,
      );
      if (iou >= threshold) candidates.push({ li, pi, iou });
    }
  }
  candidates.sort((x, y) => y.iou - x.iou);
  const assignedLabels = new Set<number>();
  const assignedPredictions = new Set<number>();
  for (const c of candidates) {
    if (assignedLabels.has(c.li) || assignedPredictions.has(c.pi)) continue;
    assignedLabels.add(c.li);
    assignedPredictions.add(c.pi);
    result.push({ label: labels[c.li]!, pred: preds[c.pi]! });
  }
  for (let li = 0; li < labels.length; li += 1) {
    if (!assignedLabels.has(li)) result.push({ label: labels[li]!, pred: null });
  }
  return result;
}

export interface AssignmentMatch {
  labelId: string;
  predictionId: string;
  temporalIou: number;
  textSimilarity?: number;
  startErrorSec: number;
  endErrorSec: number;
}

export interface HardNegativeOverlap {
  negativeLabelId: string;
  predictionId: string;
  temporalIou: number;
  predictedScore: number;
}

export interface AssignmentResult {
  positive_matches: AssignmentMatch[];
  /** Brief v5 8.2: raw (pred, label) pairs backing positive_matches — needed
   * by contamination/binary metrics that read both objects. */
  positive_pairs: { pred: Prediction; label: GoldenLabel }[];
  unmatched_positive_labels: GoldenLabel[];
  unmatched_predictions: Prediction[];
  hard_negative_overlaps: HardNegativeOverlap[];
}

/**
 * Brief v5 8.1/8.2 (G-01): canonical assignment. POSITIVE labels are matched
 * to predictions (greedy IoU, separate label/prediction namespaces) for
 * recall/boundary/rank metrics. HARD NEGATIVES are evaluated INDEPENDENTLY:
 * every prediction overlapping a hard-negative range is reported as an
 * overlap — a prediction may overlap BOTH a positive and a hard negative,
 * and both facts are reported (no single shared assignment).
 */
export function computeAssignmentResult(
  labels: GoldenLabel[],
  preds: Prediction[],
  threshold = 0.5,
): AssignmentResult {
  const positives = labels.filter((l) => (l.type ?? 'positive') === 'positive');
  const hardNegatives = labels.filter((l) => (l.type ?? 'positive') === 'hard_negative');

  // Positive matching: greedy IoU, separate namespaces.
  const posMatches = matchByTemporalIoU(positives, preds, threshold);
  const matched = posMatches.filter((m) => m.pred !== null);
  const positive_matches: AssignmentMatch[] = matched.map((m) => ({
    labelId: String(m.label.clipId),
    predictionId: String(m.pred!.clipId),
    temporalIou: temporalIoU(
      m.pred!.startSec, m.pred!.endSec,
      m.label.expectedStartSec, m.label.expectedEndSec,
    ),
    startErrorSec: Math.abs(m.pred!.startSec - m.label.expectedStartSec),
    endErrorSec: Math.abs(m.pred!.endSec - m.label.expectedEndSec),
  }));
  const usedPredIds = new Set(matched.map((m) => m.pred!.clipId));

  // Hard-negative overlaps: INDEPENDENT of the positive assignment.
  const hard_negative_overlaps: HardNegativeOverlap[] = [];
  for (const neg of hardNegatives) {
    for (const p of preds) {
      const iou = temporalIoU(
        p.startSec, p.endSec,
        neg.expectedStartSec, neg.expectedEndSec,
      );
      if (iou >= threshold) {
        hard_negative_overlaps.push({
          negativeLabelId: String(neg.clipId),
          predictionId: String(p.clipId),
          temporalIou: iou,
          predictedScore: p.score,
        });
      }
    }
  }

  return {
    positive_matches,
    positive_pairs: matched.map((m) => ({ pred: m.pred!, label: m.label })),
    unmatched_positive_labels: posMatches.filter((m) => m.pred === null).map((m) => m.label),
    unmatched_predictions: preds.filter((p) => !usedPredIds.has(p.clipId)),
    hard_negative_overlaps,
  };
}

export function evaluateGolden(labels: GoldenLabel[], preds: Prediction[], k: number): GoldenMetrics {
  // Brief v4 D2 (#9): only 'positive' labels (default) participate in recall;
  // 'hard_negative' labels matched by a prediction are false positives (never
  // recall hits), 'ignore' labels are excluded from every metric.
  const positiveLabels = labels.filter((l) => (l.type ?? 'positive') === 'positive');
  const hardNegativeLabels = labels.filter((l) => (l.type ?? 'positive') === 'hard_negative');
  const ignoredLabels = labels.filter((l) => (l.type ?? 'positive') === 'ignore');
  // Brief v5 8.1 (G-01): canonical AssignmentResult — positive matching and
  // hard-negative overlap are SEPARATE. All metrics consume THIS result.
  const assignment = computeAssignmentResult(labels, preds, 0.5);
  const positiveMatched = assignment.positive_matches;
  const temporalRecall = positiveLabels.length === 0 ? 0 : positiveMatched.length / positiveLabels.length;
  const meanTemporalIoU =
    positiveMatched.length === 0
      ? 0
      : positiveMatched.reduce((s, m) => s + m.temporalIou, 0) / positiveMatched.length;

  // Boundary errors / contamination / binary accuracy over the POSITIVE
  // matches only (brief 8.1: boundary metrics use positive matches only).
  const { start, end } = boundaryErrorFromAssignment(assignment);
  const meanContamination = contaminationErrorFromAssignment(assignment);
  const startCompleteAcc = binaryAccuracyFromAssignment(
    assignment,
    (p, l) => p.startComplete === l.expectedStartComplete,
  );
  const endingCompleteAcc = binaryAccuracyFromAssignment(
    assignment,
    (p, l) => p.endingComplete === l.expectedEndingComplete,
  );
  return {
    topKRecall: topKRecall(positiveLabels, preds, k),
    topKRankAwareRecall: topKRankAwareRecall(positiveLabels, preds, k),
    meanBoundaryStartErrorSec: round2(start),
    meanBoundaryEndErrorSec: round2(end),
    meanContaminationError: round2(meanContamination),
    startCompleteAccuracy: round2(startCompleteAcc),
    endingCompleteAccuracy: round2(endingCompleteAcc),
    n: labels.length,
    temporalRecall: round2(temporalRecall),
    meanTemporalIoU: round2(meanTemporalIoU),
    hardNegativeFPR: hardNegativeLabels.length === 0
      ? 0
      : round2(assignment.hard_negative_overlaps.length / hardNegativeLabels.length),
    hardNegativeFalsePositives: assignment.hard_negative_overlaps.length,
    ignoredLabels: ignoredLabels.length,
  };
}

/** Boundary start/end error over a COMMON temporal assignment. */
export function boundaryErrorFromMatches(
  matches: { label: GoldenLabel; pred: Prediction | null }[],
): { start: number; end: number } {
  let startSum = 0;
  let endSum = 0;
  let n = 0;
  for (const m of matches) {
    if (!m.pred) continue;
    startSum += Math.abs(m.pred.startSec - m.label.expectedStartSec);
    endSum += Math.abs(m.pred.endSec - m.label.expectedEndSec);
    n += 1;
  }
  return { start: n === 0 ? 0 : startSum / n, end: n === 0 ? 0 : endSum / n };
}

/** Contamination error over a COMMON temporal assignment. */
export function contaminationErrorFromMatches(
  matches: { label: GoldenLabel; pred: Prediction | null }[],
): number {
  let sum = 0;
  let n = 0;
  for (const m of matches) {
    if (!m.pred) continue;
    sum += Math.abs(m.pred.contamination - m.label.expectedContamination);
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

/** Binary accuracy over a COMMON temporal assignment. */
export function binaryAccuracyFromMatches(
  matches: { label: GoldenLabel; pred: Prediction | null }[],
  pick: (p: Prediction, l: GoldenLabel) => boolean,
): number {
  let correct = 0;
  let n = 0;
  for (const m of matches) {
    if (!m.pred) continue;
    if (pick(m.pred, m.label) === true) correct += 1;
    n += 1;
  }
  return n === 0 ? 0 : correct / n;
}

// ── Brief v5 8.2: metrics from the canonical AssignmentResult ──────────────

/** Boundary start/end error from positive matches only (brief 8.1). */
export function boundaryErrorFromAssignment(a: AssignmentResult): { start: number; end: number } {
  const n = a.positive_matches.length;
  if (n === 0) return { start: 0, end: 0 };
  const start = a.positive_matches.reduce((s, m) => s + m.startErrorSec, 0) / n;
  const end = a.positive_matches.reduce((s, m) => s + m.endErrorSec, 0) / n;
  return { start, end };
}

/** Contamination error from positive matches only (brief 8.1). */
export function contaminationErrorFromAssignment(a: AssignmentResult): number {
  const pairs = a.positive_pairs;
  if (pairs.length === 0) return 0;
  let sum = 0;
  for (const { pred, label } of pairs) {
    sum += Math.abs(pred.contamination - label.expectedContamination);
  }
  return sum / pairs.length;
}

/** Binary accuracy over positive matches only (brief 8.1). */
export function binaryAccuracyFromAssignment(
  a: AssignmentResult,
  pick: (p: Prediction, l: GoldenLabel) => boolean,
): number {
  const pairs = a.positive_pairs;
  if (pairs.length === 0) return 0;
  let correct = 0;
  for (const { pred, label } of pairs) {
    if (pick(pred, label) === true) correct += 1;
  }
  return correct / pairs.length;
}

/** @deprecated clipId-positional variant; kept for legacy callers. */
export function evaluateGoldenLegacy(labels: GoldenLabel[], preds: Prediction[], k: number): GoldenMetrics {
  const { start, end } = boundaryError(preds, labels);
  // Phase-2 F22: temporal matching metrics.
  const matches = matchByTemporalIoU(labels, preds, 0.5);
  const matched = matches.filter((m) => m.pred !== null);
  const temporalRecall = labels.length === 0 ? 0 : matched.length / labels.length;
  const meanTemporalIoU =
    matched.length === 0
      ? 0
      : matched.reduce((s, m) => {
          const p = m.pred!;
          return s + temporalIoU(p.startSec, p.endSec, m.label.expectedStartSec, m.label.expectedEndSec);
        }, 0) / matched.length;
  return {
    topKRecall: topKRecall(labels, preds, k),
    topKRankAwareRecall: topKRankAwareRecall(labels, preds, k),
    meanBoundaryStartErrorSec: round2(start),
    meanBoundaryEndErrorSec: round2(end),
    meanContaminationError: round2(contaminationError(preds, labels)),
    startCompleteAccuracy: round2(
      binaryAccuracy(preds, labels, (p, l) => p.startComplete === l.expectedStartComplete),
    ),
    endingCompleteAccuracy: round2(
      binaryAccuracy(preds, labels, (p, l) => p.endingComplete === l.expectedEndingComplete),
    ),
    n: labels.length,
    temporalRecall: round2(temporalRecall),
    meanTemporalIoU: round2(meanTemporalIoU),
    hardNegativeFPR: 0,
    hardNegativeFalsePositives: 0,
    ignoredLabels: 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
