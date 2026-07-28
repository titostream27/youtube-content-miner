import type { ClipDimensionScores, MomentSegment } from '@/lib/domain/types';
import { tierForScore, type PriorityTier } from '@/lib/domain/thresholds';
import {
  CLIP_DRIVER_KEYS,
  CLIP_DRIVER_SHARE,
  CLIP_DRIVER_TOP_N,
  CLIP_GATE_SHARE,
  CLIP_GATE_WEIGHTS,
  CLIP_DIMENSION_LABELS,
  type ClipDriverKey,
} from './weights';
import { clamp, piecewise, round, weightedAverage } from './normalize';

/**
 * PRD Step 5 - Clip scoring.
 *
 * The aggregation model is explained in detail in `weights.ts`. In short:
 *
 *   score = 0.55 * (mean of the 2 strongest driver dimensions)
 *         + 0.45 * (weighted mean of the gate dimensions)
 *
 * then adjusted for duration and capped by hard quality gates.
 *
 * The caps exist because a good average can otherwise smuggle a fatally flawed
 * clip into the top tier. A moment that cannot be understood without the
 * preceding hour is not a "Publish Immediately" clip even if it is brilliant,
 * and the editor needs to be told which flaw is holding it back - that is more
 * actionable than the number itself.
 */

export interface QualityCap {
  reason: string;
  ceiling: number;
}

export interface ClipScoreResult {
  /** Mean of the strongest driver dimensions. */
  driverScore: number;
  /** Weighted mean of the prerequisite dimensions. */
  gateScore: number;
  /** Composite before duration adjustment and caps, for model debugging. */
  baseScore: number;
  /** Final 0-100 score. */
  finalScore: number;
  tier: PriorityTier;
  durationMultiplier: number;
  appliedCaps: QualityCap[];
  /** The dimensions that carried the clip, strongest first. */
  topDrivers: ClipDriverKey[];
}

/**
 * Short-form retention curve. Under ~20s there is rarely room for setup plus
 * payoff; past ~75s completion rate falls off a cliff.
 */
export function durationMultiplier(durationSec: number): number {
  return piecewise(durationSec, [
    [10, 0.86],
    [15, 0.93],
    [22, 0.985],
    [30, 1],
    [58, 1],
    [70, 0.99],
    [80, 0.975],
    [90, 0.955],
    [120, 0.9],
  ]);
}

/**
 * The non-negotiables. Each entry maps a failing dimension to the highest
 * score the clip is allowed to reach.
 */
const QUALITY_GATES: readonly {
  key: keyof ClipDimensionScores;
  below: number;
  ceiling: number;
  reason: string;
}[] = [
  {
    key: 'standalone',
    below: 55,
    ceiling: 87,
    reason: 'Needs surrounding context to make sense',
  },
  {
    key: 'standalone',
    below: 40,
    ceiling: 76,
    reason: 'Cannot stand alone as a clip',
  },
  {
    key: 'clarity',
    below: 50,
    ceiling: 82,
    reason: 'Delivery is unclear or rambling',
  },
  {
    key: 'clarity',
    below: 35,
    ceiling: 70,
    reason: 'Too much filler to publish',
  },
  {
    key: 'hook',
    below: 50,
    ceiling: 86,
    reason: 'Opening does not stop the scroll',
  },
  {
    key: 'hook',
    below: 35,
    ceiling: 74,
    reason: 'No hook in the first seconds',
  },
];

/** Mean of the N strongest drivers, plus which they were. */
function topDrivers(dimensions: ClipDimensionScores): {
  score: number;
  keys: ClipDriverKey[];
} {
  const ranked = [...CLIP_DRIVER_KEYS]
    .map((key) => ({ key, value: clamp(dimensions[key]) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, CLIP_DRIVER_TOP_N);

  const score = ranked.reduce((total, entry) => total + entry.value, 0) / (ranked.length || 1);

  return { score, keys: ranked.map((entry) => entry.key) };
}

export function computeClipScore(
  dimensions: ClipDimensionScores,
  segment: Pick<MomentSegment, 'durationSec'>,
): ClipScoreResult {
  const drivers = topDrivers(dimensions);
  const gateScore = weightedAverage(
    {
      standalone: dimensions.standalone,
      clarity: dimensions.clarity,
      hook: dimensions.hook,
    },
    CLIP_GATE_WEIGHTS,
  );

  const baseScore = drivers.score * CLIP_DRIVER_SHARE + gateScore * CLIP_GATE_SHARE;
  const multiplier = durationMultiplier(segment.durationSec);

  let score = baseScore * multiplier;

  const appliedCaps: QualityCap[] = [];
  for (const gate of QUALITY_GATES) {
    if (dimensions[gate.key] < gate.below && score > gate.ceiling) {
      score = gate.ceiling;
      appliedCaps.push({ reason: gate.reason, ceiling: gate.ceiling });
    }
  }

  const finalScore = round(clamp(score));

  return {
    driverScore: round(drivers.score, 1),
    gateScore: round(gateScore, 1),
    baseScore: round(baseScore, 1),
    finalScore,
    tier: tierForScore(finalScore),
    durationMultiplier: round(multiplier, 3),
    appliedCaps,
    topDrivers: drivers.keys,
  };
}

/** Human readable summary of what carried a clip, for the UI. */
export function describeTopDrivers(keys: readonly ClipDriverKey[]): string {
  return keys.map((key) => CLIP_DIMENSION_LABELS[key]).join(' + ');
}
