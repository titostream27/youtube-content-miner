import { describe, it, expect, beforeAll } from 'vitest';
import {
  textSimilarity,
  detectDuplicates,
  upsertEmbedding,
  DUPLICATE_HARD_THRESHOLD,
  DUPLICATE_REVIEW_THRESHOLD,
} from '@/lib/db/repositories/embeddings';
import {
  computeTrendScores,
  type EpisodeMetricSnapshot,
} from '@/lib/db/repositories/episode-metrics';
import {
  applyChannelProfileAdjustment,
  type ChannelProfile,
} from '@/lib/db/repositories/channel-profiles';

function snap(id: number, views: number, likes = 0): EpisodeMetricSnapshot {
  return { id, videoId: `v${id}`, viewCount: views, likeCount: likes, capturedAt: '2026-08-01T00:00:00Z' };
}

beforeAll(() => {
  // Seed embeddings for dedup tests (temp DB via vitest.setup).
  const shared = 'expansion multiplied a business model that was already broken';
  upsertEmbedding({ clipId: 1, kind: 'clip', text: shared });
  upsertEmbedding({ clipId: 2, kind: 'clip', text: shared });
  upsertEmbedding({ clipId: 3, kind: 'clip', text: 'we went to the beach and ate ice cream' });
});

describe('textSimilarity (brief §32)', () => {
  it('returns 1.0 for identical text', () => {
    expect(textSimilarity('the product failed', 'the product failed')).toBe(1);
  });

  it('returns ~0 for unrelated text', () => {
    expect(textSimilarity('the product failed', 'we went to the beach')).toBeLessThan(0.4);
  });

  it('detects near-duplicate paraphrase', () => {
    const a = 'most companies do not fail because of the product';
    const b = 'companies rarely fail because of their product';
    expect(textSimilarity(a, b)).toBeGreaterThan(0.4);
  });
});

describe('detectDuplicates (brief §32)', () => {
  it('verdict duplicate when similarity >= 0.90', () => {
    // Identical text stored under two clip ids.
    const text = 'expansion multiplied a business model that was already broken';
    const results = detectDuplicates(1, text);
    const dup = results.find((r) => r.verdict === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup!.similarity).toBeGreaterThanOrEqual(DUPLICATE_HARD_THRESHOLD);
  });

  it('excludes self from results', () => {
    const results = detectDuplicates(2, 'expansion multiplied a business model that was already broken');
    expect(results.find((r) => r.clipId === 2)).toBeUndefined();
  });

  it('threshold constants sane', () => {
    expect(DUPLICATE_HARD_THRESHOLD).toBe(0.9);
    expect(DUPLICATE_REVIEW_THRESHOLD).toBe(0.78);
    expect(DUPLICATE_REVIEW_THRESHOLD).toBeLessThan(DUPLICATE_HARD_THRESHOLD);
  });
});

describe('computeTrendScores (brief §30)', () => {
  it('zero when no older snapshot', () => {
    const s = computeTrendScores(null, snap(1, 100));
    expect(s.trendScore).toBe(0);
  });

  it('computes viewsPerHour from growth', () => {
    const older = snap(1, 1000);
    const newer = snap(1, 1000 + 24 * 50);
    const s = computeTrendScores(older, newer, 24);
    expect(s.viewsPerHour).toBe(50);
    expect(s.trendScore).toBeGreaterThan(0);
  });

  it('breakout scores fast growth', () => {
    const older = snap(1, 100);
    const newer = snap(1, 100 + 24 * 200);
    const s = computeTrendScores(older, newer, 24);
    // Fast velocity should produce a high breakout score (clamped to 100).
    expect(s.breakoutScore).toBe(100);
    expect(s.viewsPerHour).toBe(200);
  });
});

describe('applyChannelProfileAdjustment (brief §28)', () => {
  const profile: ChannelProfile = {
    id: 1,
    profileId: 'us-podcast-clips',
    name: 'US Podcast Clips',
    preferredDurationSec: [28, 42],
    strongCategories: ['Story', 'Controversial'],
    weakCategories: ['Motivation'],
    preferredHookTypes: ['outcome_first', 'direct_statement'],
    targetMarkets: ['US'],
    active: true,
  };

  it('adds for strong category + preferred duration', () => {
    const r = applyChannelProfileAdjustment(profile, { category: 'Story', durationSec: 35, market: 'US' });
    expect(r.adjustment).toBeGreaterThan(0);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('penalizes weak category', () => {
    const r = applyChannelProfileAdjustment(profile, { category: 'Motivation', durationSec: 45 });
    expect(r.adjustment).toBeLessThan(0);
  });

  it('applies saturation penalty (brief §32)', () => {
    // Saturation alone: weak category + no duration benefit + saturation.
    const r = applyChannelProfileAdjustment(profile, { category: 'Motivation', durationSec: 60, recentlyPublishedSimilar: true });
    expect(r.adjustment).toBeLessThan(0);
    expect(r.reasons).toContain('recent saturation');
  });

  it('clamps adjustment to [-20, 20]', () => {
    const r = applyChannelProfileAdjustment(profile, {
      category: 'Story',
      durationSec: 30,
      hook: 'outcome first hook here',
      market: 'US',
      recentlyPublishedSimilar: false,
    });
    expect(r.adjustment).toBeLessThanOrEqual(20);
    expect(r.adjustment).toBeGreaterThanOrEqual(-20);
  });
});
