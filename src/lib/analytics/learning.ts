import { getLatestAnalytics, listClipsWithAnalytics } from '@/lib/db/repositories/analytics';
import { getClip } from '@/lib/db/repositories/clips';
import { LEARNING_MIN_PUBLISHED_CLIPS, LEARNING_MIN_VARIANT_SAMPLE } from '@/lib/analytics/prediction';

/**
 * Phase 4 (Master Task Brief §24) — learned re-ranking.
 *
 * Analytics flow back into scoring, but we NEVER auto-change weights from a
 * small sample. Thresholds:
 *   LEARNING_MIN_PUBLISHED_CLIPS=30   — enough to start adjusting weights
 *   LEARNING_MIN_VARIANT_SAMPLE=10    — enough to adjust variant preference
 *
 * The re-ranker outputs weight ADJUSTMENTS (delta, clamped) that a caller can
 * apply, plus explanations — it never silently rewrites the universal model.
 */

export interface WeightAdjustment {
  /** Dimension key from the clip scoring model. */
  dimension: 'hook' | 'retention' | 'shareability' | 'duration_pref';
  delta: number; // -0.1 .. +0.1
  sampleSize: number;
  reason: string;
  applied: boolean;
}

export interface ReRankResult {
  eligible: boolean;
  publishedClipsWithAnalytics: number;
  adjustments: WeightAdjustment[];
  message: string;
}

/** Weight deltas are only applied when the sample threshold is met. */
export function computeReRankAdjustments(): ReRankResult {
  const clipIds = listClipsWithAnalytics();
  const publishedWithAnalytics = clipIds
    .map((id) => getClip(id))
    .filter((c) => c !== null && c.publishStatus === 'published').length;

  const eligible = publishedWithAnalytics >= LEARNING_MIN_PUBLISHED_CLIPS;
  const adjustments: WeightAdjustment[] = [];

  // Collect evidence.
  let totalViewedRate = 0;
  let viewedCount = 0;
  let questionHookViewed = 0;
  let questionHookCount = 0;
  let over45LowRetention = 0;
  let over45Count = 0;

  for (const id of clipIds) {
    const clip = getClip(id);
    const snap = getLatestAnalytics(id);
    if (!clip || !snap) continue;

    if (snap.viewedRate !== null && snap.viewedRate !== undefined) {
      totalViewedRate += snap.viewedRate;
      viewedCount += 1;
    }
    if (snap.viewedRate !== null && snap.viewedRate !== undefined && /\?/.test(clip.suggestedHook ?? '')) {
      questionHookViewed += snap.viewedRate;
      questionHookCount += 1;
    }
    if (clip.durationSec > 45 && snap.avgPercentageViewed !== null && snap.avgPercentageViewed !== undefined) {
      if (snap.avgPercentageViewed < 0.6) over45LowRetention += 1;
      over45Count += 1;
    }
  }

  if (viewedCount >= 5) {
    const avgViewed = totalViewedRate / viewedCount;
    adjustments.push({
      dimension: 'hook',
      delta: avgViewed >= 0.6 ? 0.05 : -0.03,
      sampleSize: viewedCount,
      reason: `average viewed rate ${avgViewed.toFixed(2)} across ${viewedCount} clips`,
      applied: eligible,
    });
  }

  if (questionHookCount >= 3) {
    const avgQ = questionHookViewed / questionHookCount;
    adjustments.push({
      dimension: 'retention',
      delta: avgQ >= 0.6 ? 0.04 : -0.02,
      sampleSize: questionHookCount,
      reason: `question hooks avg viewed ${avgQ.toFixed(2)} across ${questionHookCount} clips`,
      applied: eligible,
    });
  }

  if (over45Count >= 3) {
    const ratio = over45LowRetention / over45Count;
    adjustments.push({
      dimension: 'duration_pref',
      delta: ratio >= 0.5 ? -0.05 : 0.02,
      sampleSize: over45Count,
      reason: `${over45LowRetention}/${over45Count} clips over 45s lose retention`,
      applied: eligible,
    });
  }

  const message = eligible
    ? `Sample threshold met (${publishedWithAnalytics} >= ${LEARNING_MIN_PUBLISHED_CLIPS}); adjustments apply.`
    : `Not enough data (${publishedWithAnalytics} < ${LEARNING_MIN_PUBLISHED_CLIPS}); adjustments computed but NOT applied.`;

  return {
    eligible,
    publishedClipsWithAnalytics: publishedWithAnalytics,
    adjustments,
    message,
  };
}

export { LEARNING_MIN_PUBLISHED_CLIPS, LEARNING_MIN_VARIANT_SAMPLE };
