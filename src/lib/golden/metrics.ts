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
}

export function topKRecall(labels: GoldenLabel[], preds: Prediction[], k: number): number {
  const labelTop = labels
    .slice()
    .sort((a, b) => b.expectedScore - a.expectedScore)
    .slice(0, k)
    .map((l) => l.clipId);
  const predTop = preds
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((p) => p.clipId);
  const hit = labelTop.filter((id) => predTop.includes(id)).length;
  return labelTop.length === 0 ? 0 : hit / labelTop.length;
}

export function topKRankAwareRecall(labels: GoldenLabel[], preds: Prediction[], k: number): number {
  const labelTop = labels
    .slice()
    .sort((a, b) => b.expectedScore - a.expectedScore)
    .slice(0, k);
  const predTop = preds
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((p) => p.clipId);
  if (labelTop.length === 0) return 0;
  let sum = 0;
  for (const [rank, label] of labelTop.entries()) {
    const idx = predTop.indexOf(label.clipId);
    if (idx >= 0) {
      // Reciprocal-rank style: full credit at exact position, decaying after.
      sum += 1 / (1 + Math.abs(idx - rank));
    }
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
  const assigned = new Set<number>();
  for (const c of candidates) {
    if (assigned.has(c.li) || assigned.has(c.pi)) continue;
    assigned.add(c.li);
    assigned.add(c.pi);
    result.push({ label: labels[c.li]!, pred: preds[c.pi]! });
  }
  for (let li = 0; li < labels.length; li += 1) {
    if (!assigned.has(li)) result.push({ label: labels[li]!, pred: null });
  }
  return result;
}

export function evaluateGolden(labels: GoldenLabel[], preds: Prediction[], k: number): GoldenMetrics {
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
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
