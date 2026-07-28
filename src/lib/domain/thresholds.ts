/**
 * PRD Step 7 - Threshold filtering.
 *
 * The product deliberately does NOT return a fixed number of clips per
 * episode. A 3 hour episode may yield 14 great moments; another may yield
 * zero. Everything is driven by score thresholds so the output volume tracks
 * the actual quality of the source material.
 */

export const PRIORITY_TIERS = [
  'publish_immediately',
  'high_priority',
  'good_candidate',
  'optional',
  'archive',
] as const;

export type PriorityTier = (typeof PRIORITY_TIERS)[number];

export interface TierDefinition {
  tier: PriorityTier;
  label: string;
  /** Inclusive lower bound of the final score. */
  minScore: number;
  /** Inclusive upper bound of the final score. */
  maxScore: number;
  description: string;
  /** Tailwind classes used by the badge component. */
  className: string;
  accentClassName: string;
}

export const TIER_DEFINITIONS: readonly TierDefinition[] = [
  {
    tier: 'publish_immediately',
    label: 'Publish Immediately',
    minScore: 95,
    maxScore: 100,
    description: 'Send straight to the editor. No further review needed.',
    className: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30',
    accentClassName: 'bg-emerald-500',
  },
  {
    tier: 'high_priority',
    label: 'High Priority',
    minScore: 90,
    maxScore: 94,
    description: 'Strong candidate. Queue in the current batch.',
    className: 'bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-500/30',
    accentClassName: 'bg-sky-500',
  },
  {
    tier: 'good_candidate',
    label: 'Good Candidate',
    minScore: 85,
    maxScore: 89,
    description: 'Worth cutting when the high priority queue is clear.',
    className: 'bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-500/30',
    accentClassName: 'bg-violet-500',
  },
  {
    tier: 'optional',
    label: 'Optional',
    minScore: 80,
    maxScore: 84,
    description: 'Filler content. Use only if the calendar has gaps.',
    className: 'bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30',
    accentClassName: 'bg-amber-500',
  },
  {
    tier: 'archive',
    label: 'Archive',
    minScore: 0,
    maxScore: 79,
    description: 'Kept for model training and future re-ranking only.',
    className: 'bg-slate-500/15 text-slate-400 ring-1 ring-inset ring-slate-500/30',
    accentClassName: 'bg-slate-500',
  },
];

const TIER_BY_KEY = new Map<PriorityTier, TierDefinition>(
  TIER_DEFINITIONS.map((definition) => [definition.tier, definition]),
);

export function tierForScore(finalScore: number): PriorityTier {
  if (finalScore >= 95) return 'publish_immediately';
  if (finalScore >= 90) return 'high_priority';
  if (finalScore >= 85) return 'good_candidate';
  if (finalScore >= 80) return 'optional';
  return 'archive';
}

export function tierDefinition(tier: PriorityTier): TierDefinition {
  const definition = TIER_BY_KEY.get(tier);
  if (!definition) {
    throw new Error(`Unknown priority tier: ${tier}`);
  }
  return definition;
}

export function tierLabel(tier: PriorityTier): string {
  return tierDefinition(tier).label;
}

/**
 * Score below which a clip is not surfaced in the working library at all.
 * Archive clips are still persisted (they are the training dataset that
 * becomes the long-term moat) but they never reach the editor.
 */
export const LIBRARY_MIN_SCORE = 80;

/**
 * Ranking order used everywhere the UI sorts by priority.
 */
export const TIER_RANK: Record<PriorityTier, number> = {
  publish_immediately: 0,
  high_priority: 1,
  good_candidate: 2,
  optional: 3,
  archive: 4,
};
