import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/config', () => ({
  config: {
    youtube: { demoMode: false },
  },
}));

vi.mock('@/lib/youtube/client', () => ({
  listTrendingVideos: vi.fn(),
  listChannels: vi.fn(),
  listChannelUploads: vi.fn(),
  listVideos: vi.fn(),
  searchVideos: vi.fn(),
  searchChannels: vi.fn(),
  bestThumbnail: () => 'https://img/thumb.jpg',
  toNumber: (v?: string) => (v ? Number(v) : 0),
  YouTubeApiError: class extends Error {},
}));

import { discoverFromTrending } from '@/lib/youtube/discovery';
import { listTrendingVideos, listChannels } from '@/lib/youtube/client';

function video(id: string, duration: string, embeddable = true) {
  return {
    id,
    snippet: {
      title: `Title ${id}`,
      description: '',
      channelId: 'UCchan',
      channelTitle: 'Chan',
      publishedAt: '2026-08-01T00:00:00Z',
      tags: [],
    },
    contentDetails: { duration },
    statistics: { viewCount: '1000' },
    status: { embeddable, license: 'youtube' },
  };
}

const chan = {
  id: 'UCchan',
  snippet: { title: 'Chan', customUrl: '@chan' },
  statistics: { subscriberCount: '100', videoCount: '5', viewCount: '1000' },
};

describe('discoverFromTrending', () => {
  it('returns only embeddable long-form trending videos', async () => {
    vi.mocked(listTrendingVideos).mockResolvedValue([
      video('1', 'PT30M', true), // long, embeddable -> kept
      video('2', 'PT20S', true), // short -> dropped
      video('3', 'PT10M', false), // long but not embeddable -> dropped
    ] as never);
    vi.mocked(listChannels).mockResolvedValue([chan] as never);

    const outcome = await discoverFromTrending({ regionCode: 'ID', maxResults: 10 });
    expect(outcome.source).toBe('live');
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]!.videoId).toBe('1');
    expect(outcome.candidates[0]!.durationSeconds).toBe(1800);
  });

  it('returns empty candidates with warning when nothing long-form remains', async () => {
    vi.mocked(listTrendingVideos).mockResolvedValue([
      video('1', 'PT15S', true),
      video('2', 'PT30S', true),
    ] as never);

    const outcome = await discoverFromTrending({ regionCode: 'ID' });
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.warnings.some((w) => w.includes('No long-form'))).toBe(true);
  });
});
