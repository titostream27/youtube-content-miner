import { tierDefinition, type PriorityTier } from '@/lib/domain/thresholds';
import { cn } from '@/lib/utils/cn';

/**
 * PRD Step 7 made visible.
 *
 * The tier, not the raw score, is the thing the editor acts on, so it gets the
 * colour and the score sits beside it as supporting detail.
 */
export function TierBadge({ tier, className }: { tier: PriorityTier; className?: string }) {
  const definition = tierDefinition(tier);

  return (
    <span
      title={definition.description}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        definition.className,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', definition.accentClassName)} />
      {definition.label}
    </span>
  );
}

/**
 * Score and confidence, always together.
 *
 * Showing a 96 without its confidence is the single easiest way to make this
 * product untrustworthy, so the component refuses to render one without the
 * other.
 */
export function ScoreBadge({
  score,
  confidence,
  size = 'md',
}: {
  score: number;
  confidence: number;
  size?: 'sm' | 'md';
}) {
  const scoreColor =
    score >= 95
      ? 'text-emerald-300'
      : score >= 90
        ? 'text-sky-300'
        : score >= 85
          ? 'text-violet-300'
          : score >= 80
            ? 'text-amber-300'
            : 'text-slate-400';

  const confidenceColor =
    confidence >= 85 ? 'text-slate-300' : confidence >= 70 ? 'text-slate-400' : 'text-amber-400/80';

  return (
    <div className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span
        className={cn(
          'numeric font-semibold tabular-nums',
          size === 'md' ? 'text-2xl' : 'text-lg',
          scoreColor,
        )}
      >
        {score}
      </span>
      <span
        className={cn('numeric tabular-nums', size === 'md' ? 'text-xs' : 'text-[11px]', confidenceColor)}
        title="Confidence: how much the engine trusts this score"
      >
        {confidence}%
      </span>
    </div>
  );
}


/**
 * PRD Step 2 - the Episode Opportunity Score.
 *
 * Kept visually distinct from a clip score, because they answer different
 * questions: this one predicts whether an episode is worth paying to analyse,
 * and it has no confidence value attached.
 */
export function OpportunityScore({
  score,
  threshold,
  size = 'md',
}: {
  score: number | null;
  threshold?: number;
  size?: 'sm' | 'md';
}) {
  if (score === null) {
    return <span className="text-xs text-slate-600">-</span>;
  }

  const passes = threshold === undefined || score >= threshold;

  return (
    <span
      title={
        threshold === undefined
          ? 'Episode Opportunity Score (0-100)'
          : passes
            ? `Cleared the ${threshold} analysis threshold`
            : `Below the ${threshold} analysis threshold, so this episode was never transcribed`
      }
      className={cn(
        'numeric font-semibold tabular-nums',
        size === 'md' ? 'text-lg' : 'text-sm',
        passes ? 'text-slate-200' : 'text-slate-500',
      )}
    >
      {Math.round(score)}
    </span>
  );
}
