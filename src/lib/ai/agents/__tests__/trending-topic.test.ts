import { describe, it, expect, vi, beforeEach } from 'vitest';

// Force the LLM path off so planTrendingTopics always exercises the
// deterministic fallback in the "agent inactive" branch.
vi.mock('@/lib/ai/client', () => ({
  isAgentActive: () => false,
  runJsonAgent: vi.fn(),
}));

import {
  fallbackTrendingTopics,
  planTrendingTopics,
} from '@/lib/ai/agents/trending-topic-agent';
import type { VideoItem } from '@/lib/youtube/client';

function video(id: string, title: string): VideoItem {
  return {
    id,
    snippet: {
      title,
      description: '',
      channelId: 'UCtest',
      channelTitle: 'Test Channel',
      publishedAt: '2026-08-01T00:00:00Z',
      tags: [],
    },
    contentDetails: { duration: 'PT30M' },
    statistics: {},
  } as VideoItem;
}

describe('fallbackTrendingTopics — heuristic keyword clustering', () => {
  it('returns the most common keyword across trending titles', () => {
    const videos = [
      video('1', 'Crypto markets are booming this year'),
      video('2', 'The crypto revolution explained'),
      video('3', 'How crypto changes everything'),
    ];
    const plan = fallbackTrendingTopics(videos, 3);
    expect(plan.topics[0]).toBe('crypto');
    expect(plan.topics.length).toBeLessThanOrEqual(3);
  });

  it('returns a default topic when nothing meaningful is shared', () => {
    const videos = [video('1', 'Cat video'), video('2', 'Dinner recipe')];
    const plan = fallbackTrendingTopics(videos, 3);
    expect(plan.topics.length).toBeGreaterThanOrEqual(1);
  });

  it('respects maxTopics', () => {
    const videos = [
      video('1', 'AI news update'),
      video('2', 'AI and crypto collide'),
      video('3', 'Crypto winter begins'),
      video('4', 'Crypto regulation explained'),
      video('5', 'SpaceX launches again'),
    ];
    const plan = fallbackTrendingTopics(videos, 2);
    expect(plan.topics.length).toBeLessThanOrEqual(2);
  });
});

describe('planTrendingTopics — agent inactive fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to heuristic when the agent is inactive', async () => {
    const result = await planTrendingTopics({
      videos: [video('1', 'AI startups are booming'), video('2', 'AI news today')],
    });
    expect(result.aiGenerated).toBe(false);
    expect(result.plan.topics.length).toBeGreaterThanOrEqual(1);
  });
});
