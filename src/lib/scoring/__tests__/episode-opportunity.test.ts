import { describe, it, expect } from 'vitest';
import { scoreEpisodeOpportunity } from '@/lib/scoring/episode-opportunity';
import { EPISODE_FACTOR_WEIGHTS } from '@/lib/scoring/weights';
import type { EpisodeCandidate } from '@/lib/domain/types';

function cand(overrides: Partial<EpisodeCandidate> = {}): EpisodeCandidate {
  return {
    videoId: 'v1',
    title: 'How we scaled to 100 employees',
    description: 'Startup growth, hiring, culture fit, churn reduction.',
    channelId: 'c1',
    channelTitle: 'Founders Off Record',
    publishedAt: '2026-07-01T00:00:00Z',
    durationSeconds: 2700, // 45 min
    viewCount: 120_000,
    likeCount: 3_000,
    commentCount: 400,
    thumbnailUrl: null,
    tags: ['startup', 'growth', 'hiring'],
    hasCaptions: true,
    license: 'creativeCommon',
    embeddable: true,
    channel: {
      channelId: 'c1',
      title: 'Founders Off Record',
      handle: '@foundersoffrecord',
      thumbnailUrl: null,
      subscriberCount: 300_000,
      videoCount: 180,
      viewCount: 30_000_000,
    },
    ...overrides,
  };
}

describe('Phase 2 opportunity scoring factors (§opportunity scoring)', () => {
  it('weights sum to 1 with the new factors', () => {
    const sum = Object.values(EPISODE_FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(EPISODE_FACTOR_WEIGHTS.channelRelativeVelocity).toBeGreaterThan(0);
    expect(EPISODE_FACTOR_WEIGHTS.momentum).toBeGreaterThan(0);
    expect(EPISODE_FACTOR_WEIGHTS.personalFit).toBeGreaterThan(0);
    expect(EPISODE_FACTOR_WEIGHTS.processingCostEfficiency).toBeGreaterThan(0);
  });

  it('returns all 12 factors', () => {
    const r = scoreEpisodeOpportunity(cand(), { topic: 'startup growth', now: new Date('2026-07-10T00:00:00Z') });
    expect(Object.keys(r.factors)).toHaveLength(12);
    expect(r.factors.channelRelativeVelocity).toBeDefined();
    expect(r.factors.momentum).toBeDefined();
    expect(r.factors.personalFit).toBeDefined();
    expect(r.factors.processingCostEfficiency).toBeDefined();
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('personal fit boosts a matching episode and stays neutral without a profile', () => {
    const now = new Date('2026-07-10T00:00:00Z');
    const withProfile = scoreEpisodeOpportunity(cand(), {
      topic: 'startup growth',
      now,
      personalTopics: ['startup growth', 'hiring culture'],
    });
    const noProfile = scoreEpisodeOpportunity(cand(), { topic: 'startup growth', now });
    expect(withProfile.factors.personalFit).toBeGreaterThan(noProfile.factors.personalFit);
    // Cold start must not be a heavy penalty.
    expect(noProfile.factors.personalFit).toBeGreaterThan(50);
  });

  it('channel-relative velocity rewards small-channel outliers', () => {
    const now = new Date('2026-07-10T00:00:00Z');
    // Same absolute views, tiny channel baseline -> higher relative velocity.
    const smallChan = scoreEpisodeOpportunity(
      cand({
        viewCount: 100_000,
        channel: {
          channelId: 'c-small',
          title: 'Tiny',
          handle: '@tiny',
          thumbnailUrl: null,
          subscriberCount: 20_000,
          videoCount: 40,
          viewCount: 500_000,
        },
      }),
      { now },
    );
    const bigChan = scoreEpisodeOpportunity(
      cand({
        viewCount: 100_000,
        channel: {
          channelId: 'c-big',
          title: 'Huge',
          handle: '@huge',
          thumbnailUrl: null,
          subscriberCount: 5_000_000,
          videoCount: 500,
          viewCount: 2_000_000_000,
        },
      }),
      { now },
    );
    expect(smallChan.factors.channelRelativeVelocity).toBeGreaterThan(bigChan.factors.channelRelativeVelocity);
  });

  it('processing cost efficiency penalizes very long episodes', () => {
    const now = new Date('2026-07-10T00:00:00Z');
    const short = scoreEpisodeOpportunity(cand({ durationSeconds: 2700 }), { now });
    const marathon = scoreEpisodeOpportunity(cand({ durationSeconds: 18_000 }), { now }); // 5h
    expect(short.factors.processingCostEfficiency).toBeGreaterThan(marathon.factors.processingCostEfficiency);
  });
});
