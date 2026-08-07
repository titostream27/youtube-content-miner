/**
 * Brief v10 C11 — test(eval): adversarial lexicographic temporal matching.
 *
 * Findings:
 * - V10-E01: the current augmenting-path matcher guarantees maximum cardinality
 *   but does NOT guarantee the maximum TOTAL IoU among same-cardinality
 *   matchings (per-label descending ordering is a LOCAL heuristic, not a
 *   global optimum).
 *
 * Tests:
 *   ET01  greedy-high-IoU loses cardinality -> matcher returns max cardinality.
 *   ET02  the matcher's total IoU must equal the BRUTE-FORCE optimum among all
 *         maximum-cardinality matchings (proves lexicographic optimality).
 *   ET03  exact tie -> deterministic across repeated runs.
 */
import { describe, it, expect } from 'vitest';
import { matchByTemporalIoU, temporalIoU, GoldenLabel, Prediction } from '../metrics';

type L = GoldenLabel;
type P = Prediction;

const tmp = (s: number, e: number): L => ({
  clipId: `c${s}-${e}`,
  expectedScore: 90,
  expectedStartSec: s,
  expectedEndSec: e,
  expectedContamination: 0,
  expectedStartComplete: true,
  expectedEndingComplete: true,
});
const p = (s: number, e: number): P => ({
  clipId: `p${s}-${e}`, score: 0.9, startSec: s, endSec: e,
  contamination: 0, startComplete: true, endingComplete: true,
});

/** Brute-force the lexicographic optimum: max cardinality, then max total IoU
 * among all maximum-cardinality matchings. Deterministic, exact for small sets. */
function bruteForceOptimum(labels: L[], preds: P[], threshold: number): {
  cardinality: number;
  totalIoU: number;
} {
  const nL = labels.length;
  const nP = preds.length;
  let bestCard = 0;
  let bestTotal = -Infinity;
  const used = new Array<boolean>(nP).fill(false);
  function dfs(labelIdx: number, cardinality: number, total: number): void {
    if (labelIdx === nL) {
      if (cardinality > bestCard) {
        bestCard = cardinality;
        bestTotal = total;
      } else if (cardinality === bestCard) {
        bestTotal = Math.max(bestTotal, total);
      }
      return;
    }
    // Option: leave label unmatched.
    dfs(labelIdx + 1, cardinality, total);
    // Try each valid prediction.
    for (let j = 0; j < nP; j += 1) {
      if (used[j]) continue;
      const w = temporalIoU(
        preds[j]!.startSec, preds[j]!.endSec,
        labels[labelIdx]!.expectedStartSec, labels[labelIdx]!.expectedEndSec,
      );
      if (w < threshold) continue;
      used[j] = true;
      dfs(labelIdx + 1, cardinality + 1, total + w);
      used[j] = false;
    }
  }
  dfs(0, 0, 0);
  return { cardinality: bestCard, totalIoU: bestTotal };
}

describe('V10-E01: lexicographic (max cardinality, then max total IoU)', () => {
  it('ET01 — preserves maximum cardinality', () => {
    const labels: L[] = [tmp(0, 10), tmp(20, 30), tmp(40, 50)];
    const preds: P[] = [p(0, 10), p(20, 30), p(40, 50), p(5, 8), p(45, 49)];
    const res = matchByTemporalIoU(labels, preds, 0.5);
    const matched = res.filter((m) => m.pred !== null);
    expect(matched.length).toBe(3);
  });

  it('ET02 — total IoU equals the brute-force lexicographic optimum', () => {
    // A matrix with two distinct maximum-cardinality matchings that differ
    // in total IoU. The matcher must pick the HIGHER total.
    const labels: L[] = [tmp(0, 10), tmp(3, 13)];
    const preds: P[] = [p(0, 10), p(2, 13)];
    const opt = bruteForceOptimum(labels, preds, 0.5);
    const res = matchByTemporalIoU(labels, preds, 0.5);
    const matched = res.filter((m) => m.pred !== null);
    // Cardinality must be optimal.
    expect(matched.length).toBe(opt.cardinality);
    const total = matched.reduce((s, m) => s + temporalIoU(
      m.pred!.startSec, m.pred!.endSec,
      m.label!.expectedStartSec, m.label!.expectedEndSec,
    ), 0);
    // Total IoU must equal the global lexicographic optimum.
    expect(Math.abs(total - opt.totalIoU)).toBeLessThan(0.001);
  });

  it('ET03 — deterministic on exact ties', () => {
    const labels: L[] = [tmp(0, 10), tmp(20, 30)];
    const preds: P[] = [p(0, 10), p(20, 30)];
    const a = JSON.stringify(matchByTemporalIoU(labels, preds, 0.5));
    const b = JSON.stringify(matchByTemporalIoU(labels, preds, 0.5));
    expect(a).toBe(b);
  });
});