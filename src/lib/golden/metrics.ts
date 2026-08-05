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

export function evaluateGolden(labels: GoldenLabel[], preds: Prediction[], k: number): GoldenMetrics {
  const { start, end } = boundaryError(preds, labels);
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
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
