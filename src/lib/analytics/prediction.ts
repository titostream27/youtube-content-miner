import { getClip } from '@/lib/db/repositories/clips';
import { getLatestAnalytics } from '@/lib/db/repositories/analytics';

/**
 * Phase 3 (Master Task Brief §27) — prediction vs actual comparison.
 *
 * Predicted comes from the clip's scoring dimensions; actual comes from the
 * latest analytics snapshot. We NEVER auto-change scoring weights from small
 * samples (LEARNING_MIN_PUBLISHED_CLIPS / LEARNING_MIN_VARIANT_SAMPLE).
 */

export const LEARNING_MIN_PUBLISHED_CLIPS = 30;
export const LEARNING_MIN_VARIANT_SAMPLE = 10;

export interface PredictionComparison {
  clipId: number;
  title: string;
  predicted: {
    hook: number;
    standalone: number;
    shareability: number;
    finalScore: number;
  };
  actual: {
    viewedRate: number | null;
    retention3s: number | null;
    averagePercentageViewed: number | null;
    shareRate: number | null;
  };
  /** Human-readable insight strings (brief §27). */
  insights: string[];
  /** True when this sample is eligible for learning (sample threshold met). */
  learnable: boolean;
  publishedClipCount: number;
}

export function comparePredictionVsActual(clipId: number, publishedClipCount: number): PredictionComparison | null {
  const clip = getClip(clipId);
  if (!clip) return null;
  const snap = getLatestAnalytics(clipId);

  const predicted = {
    hook: Math.round(clip.dimensions.hook ?? 0),
    standalone: Math.round(clip.dimensions.standalone ?? 0),
    shareability: Math.round(clip.dimensions.shareability ?? 0),
    finalScore: Math.round(clip.finalScore),
  };

  const actual = {
    viewedRate: snap?.viewedRate ?? null,
    retention3s: snap?.retention3s ?? null,
    averagePercentageViewed: snap?.avgPercentageViewed ?? null,
    shareRate: snap && snap.views > 0 && (snap.shares ?? 0) > 0 ? (snap.shares ?? 0) / snap.views : null,
  };

  const insights: string[] = [];
  const hook = actual.viewedRate ?? null;
  const retention = actual.retention3s ?? null;
  const apv = actual.averagePercentageViewed ?? null;

  // Question hooks outperform statement hooks (approximation: question in hook).
  if (hook !== null) {
    const hookIsQuestion = /\?/.test(clip.suggestedHook ?? '');
    if (hookIsQuestion && hook >= 0.6) insights.push('Question hook performing above 60% viewed rate.');
    if (!hookIsQuestion && hook < 0.5) insights.push('Statement hook below 50% viewed rate — consider a question hook.');
  }

  // Personal stories have higher completion.
  if (retention !== null && retention >= 0.75 && /(i|we|my|saya|kami)/i.test(clip.title)) {
    insights.push('High 3s retention for a personal story.');
  }

  // Clips over 45 seconds lose retention.
  if (apv !== null && clip.durationSec > 45 && apv < 0.6) {
    insights.push('Clip over 45s losing retention — shorten the boundary.');
  }

  // Split-screen performs better for debate.
  if (retention !== null && retention >= 0.7 && clip.category === 'Controversial') {
    insights.push('Controversial/debate clip retaining well — consider split-screen layout.');
  }

  return {
    clipId,
    title: clip.title,
    predicted,
    actual,
    insights,
    learnable: publishedClipCount >= LEARNING_MIN_PUBLISHED_CLIPS,
    publishedClipCount,
  };
}
