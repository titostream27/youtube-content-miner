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
  // Brief v4 D3 (F21): rank-aware recall also matches temporally. The score
  // rank of the PREDICTION that matched each label determines the credit.
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
  let sum = 0;
  for (const [rank, m] of matches.entries()) {
    if (!m.pred) continue;
    const idx = predTop.indexOf(m.pred);
    // Full credit at the label's rank, decaying as the matched prediction
    // falls further below it.
    sum += 1 / (1 + Math.abs(idx - rank));
  }
  return sum / labelTop.length;
}

export function boundaryError(preds: Prediction[], labels: GoldenLabel[]): { start: number; end: number } {
  const byId = new Map(labels.map((l) => [l.clipId, l]));
  let startSum = 0;
  let endSum = 0;
  let n = 0;
  for (const p of preds) {
    const label = byId.get(p.clipId);
    if (!label) continue;
    startSum += Math.abs(p.startSec - label.expectedStartSec);
    endSum += Math.abs(p.endSec - label.expectedEndSec);
    n += 1;
  }
  return {
    start: n === 0 ? 0 : startSum / n,
    end: n === 0 ? 0 : endSum / n,
  };
}

export function contaminationError(preds: Prediction[], labels: GoldenLabel[]): number {
  const byId = new Map(labels.map((l) => [l.clipId, l]));
  let sum = 0;
  let n = 0;
  for (const p of preds) {
    const label = byId.get(p.clipId);
    if (!label) continue;
    sum += Math.abs(p.contamination - label.expectedContamination);
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

export function binaryAccuracy(
  preds: Prediction[],
  labels: GoldenLabel[],
  pick: (p: Prediction, l: GoldenLabel) => boolean,
): number {
  const byId = new Map(labels.map((l) => [l.clipId, l]));
  let correct = 0;
  let n = 0;
  for (const p of preds) {
    const label = byId.get(p.clipId);
    if (!label) continue;
    if (pick(p, label) === true) correct += 1;
    n += 1;
  }
  return n === 0 ? 0 : correct / n;
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

export function evaluateGolden(labels: GoldenLabel[], preds: Prediction[], k: number): GoldenMetrics {
  // Brief v4 D2 (#9): only 'positive' labels (default) participate in recall;
  // 'hard_negative' labels matched by a prediction are false positives (never
  // recall hits), 'ignore' labels are excluded from every metric.
  const positiveLabels = labels.filter((l) => (l.type ?? 'positive') === 'positive');
  const hardNegativeLabels = labels.filter((l) => (l.type ?? 'positive') === 'hard_negative');
  const ignoredLabels = labels.filter((l) => (l.type ?? 'positive') === 'ignore');
  // Hardening v3 F2 (#32): EVERY boundary-sensitive metric is computed from
  // the SAME common temporal assignment (matchByTemporalIoU). No metric
  // silently falls back to a clipId-positional map.
  const matches = matchByTemporalIoU(labels, preds, 0.5);
  const matched = matches.filter((m) => m.pred !== null);
  const positiveMatched = matched.filter((m) => (m.label.type ?? 'positive') === 'positive');
  const hardNegativeFalsePositives = matched.filter((m) => (m.label.type ?? 'positive') === 'hard_negative');
  const temporalRecall = positiveLabels.length === 0 ? 0 : positiveMatched.length / positiveLabels.length;
  const meanTemporalIoU =
    positiveMatched.length === 0
      ? 0
      : positiveMatched.reduce((s, m) => {
          const p = m.pred!;
          return s + temporalIoU(p.startSec, p.endSec, m.label.expectedStartSec, m.label.expectedEndSec);
        }, 0) / positiveMatched.length;

  // Boundary errors / contamination / binary accuracy over the COMMON
  // assignment (matched pairs only, same windows as recall). Ignore labels
  // never appear here.
  const activeMatches = matches.filter((m) => (m.label.type ?? 'positive') !== 'ignore');
  const { start, end } = boundaryErrorFromMatches(activeMatches);
  const meanContamination = contaminationErrorFromMatches(activeMatches);
  const startCompleteAcc = binaryAccuracyFromMatches(
    activeMatches,
    (p, l) => p.startComplete === l.expectedStartComplete,
  );
  const endingCompleteAcc = binaryAccuracyFromMatches(
    activeMatches,
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
    // Brief v4 D2 (#9): hard-negative false-positive rate and ignore count
    // are explicit so evaluators reward desired detections and penalize
    // forbidden ranges.
    hardNegativeFPR: hardNegativeLabels.length === 0
      ? 0
      : round2(hardNegativeFalsePositives.length / hardNegativeLabels.length),
    hardNegativeFalsePositives: hardNegativeFalsePositives.length,
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
