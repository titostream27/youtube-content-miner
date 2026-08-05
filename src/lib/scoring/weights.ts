import type { ClipDimensionKey, EpisodeFactorKey } from '@/lib/domain/types';

/**
 * PRD Step 2 - Episode Opportunity Score weights.
 *
 * Topic relevance dominates because analysing an off-topic episode is pure
 * wasted spend. Recency is deliberately light: archive mining (Mode C) must
 * still be able to surface a three year old episode that happens to be great.
 *
 * Weights must sum to 1.
 */
export const EPISODE_FACTOR_WEIGHTS: Record<EpisodeFactorKey, number> = {
  topicRelevance: 0.22,
  durationFit: 0.09,
  engagement: 0.12,
  viewVelocity: 0.1,
  recency: 0.06,
  channelQuality: 0.1,
  discussionDensity: 0.08,
  expectedClipDensity: 0.08,
  // Phase 2 (Opportunity scoring): channel-relative + economic factors.
  channelRelativeVelocity: 0.05,
  momentum: 0.03,
  personalFit: 0.03,
  processingCostEfficiency: 0.04,
};

export const EPISODE_FACTOR_LABELS: Record<EpisodeFactorKey, string> = {
  topicRelevance: 'Topic Relevance',
  durationFit: 'Duration Fit',
  engagement: 'Engagement',
  viewVelocity: 'View Velocity',
  recency: 'Upload Recency',
  channelQuality: 'Channel Quality',
  discussionDensity: 'Discussion Density',
  expectedClipDensity: 'Expected Clip Density',
  channelRelativeVelocity: 'Channel-Relative Velocity',
  momentum: 'Momentum',
  personalFit: 'Personal Fit',
  processingCostEfficiency: 'Processing Cost Efficiency',
};

/* -------------------------------------------------------------------------- */
/* PRD Step 5 - Clip scoring model                                            */
/* -------------------------------------------------------------------------- */

/**
 * Why this is not a flat weighted average of the ten dimensions.
 *
 * A flat average makes every dimension a requirement. Under that model a
 * masterclass explanation of compound interest gets marked down for not being
 * controversial, and a devastating personal story gets marked down for having no
 * teaching value. Average the ten and almost nothing clears 80, because no real
 * moment is strong on all ten axes at once. The threshold tiers in Step 7 then
 * collapse into a single bucket and the product stops making decisions.
 *
 * That is backwards. Short-form clips do not win by being adequate at ten
 * things. They win by being exceptional at one or two, while not failing at the
 * few things that are genuinely mandatory.
 *
 * So the model has two parts:
 *
 *   GATES   Prerequisites. A viewer must be able to understand the clip with no
 *           context (standalone), follow it (clarity), and have a reason to
 *           keep watching past second three (hook). Fail these and nothing else
 *           can save the clip.
 *
 *   DRIVERS What actually makes a clip travel. Only the strongest few count, so
 *           a clip is rewarded for its peak rather than penalised for the axes
 *           it was never trying to hit.
 *
 * `hook` deliberately appears in both sets. It is a prerequisite - no hook, no
 * views - and it is also, on its own, enough to carry a clip when it is
 * exceptional.
 */

/** Prerequisites. Weights must sum to 1. */
export const CLIP_GATE_WEIGHTS = {
  standalone: 0.4,
  clarity: 0.3,
  hook: 0.3,
} as const satisfies Partial<Record<ClipDimensionKey, number>>;

export type ClipGateKey = keyof typeof CLIP_GATE_WEIGHTS;

/** Dimensions that can make a clip exceptional. */
export const CLIP_DRIVER_KEYS = [
  'hook',
  'curiosity',
  'emotion',
  'storytelling',
  'shareability',
  'controversy',
  'teachingValue',
  'entertainment',
] as const satisfies readonly ClipDimensionKey[];

export type ClipDriverKey = (typeof CLIP_DRIVER_KEYS)[number];

/**
 * How many of the strongest drivers count.
 *
 * Two: a peak and one supporting strength. At one, a single lucky dimension
 * carries an otherwise flat clip. At three or more we drift back towards
 * penalising a focused clip for the axes it was never aiming at - a pure
 * teaching moment has exactly one or two things going for it, and that is
 * enough.
 */
export const CLIP_DRIVER_TOP_N = 2;

/** Split between peak strength and meeting the prerequisites. Must sum to 1. */
export const CLIP_DRIVER_SHARE = 0.55;
export const CLIP_GATE_SHARE = 0.45;

export const CLIP_DIMENSION_LABELS: Record<ClipDimensionKey, string> = {
  hook: 'Hook',
  curiosity: 'Curiosity',
  emotion: 'Emotion',
  storytelling: 'Storytelling',
  standalone: 'Standalone',
  shareability: 'Shareability',
  clarity: 'Clarity',
  controversy: 'Controversy',
  teachingValue: 'Teaching Value',
  entertainment: 'Entertainment',
};

export const CLIP_DIMENSION_HELP: Record<ClipDimensionKey, string> = {
  hook: 'Does the first sentence stop a scroll? Prerequisite and driver.',
  curiosity: 'Does it open a loop the viewer needs closed?',
  emotion: 'Genuine emotional charge, not enthusiasm.',
  storytelling: 'A concrete narrative with people, numbers and stakes.',
  standalone: 'Understandable with zero context from the rest of the episode.',
  shareability: 'Would a viewer send this to someone specific?',
  clarity: 'Delivered cleanly, without rambling or hedging.',
  controversy: 'Stakes out a position someone would argue with.',
  teachingValue: 'The viewer leaves knowing something actionable.',
  entertainment: 'Funny, surprising or charismatic to watch.',
};

/** Guards against a future edit silently unbalancing a model. */
function assertNormalised(name: string, weights: Record<string, number>): void {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`${name} weights must sum to 1, got ${total.toFixed(6)}`);
  }
}

assertNormalised('EPISODE_FACTOR_WEIGHTS', EPISODE_FACTOR_WEIGHTS);
assertNormalised('CLIP_GATE_WEIGHTS', CLIP_GATE_WEIGHTS);
assertNormalised('CLIP score shares', {
  drivers: CLIP_DRIVER_SHARE,
  gates: CLIP_GATE_SHARE,
});
