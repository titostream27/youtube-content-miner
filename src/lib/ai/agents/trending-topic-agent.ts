import { z } from 'zod';
import { isAgentActive, runJsonAgent, type AgentOverrides, type UsageLedger } from '../client';
import type { VideoItem } from '@/lib/youtube/client';
import { parseIsoDuration } from '@/lib/youtube/duration';
import { PODCAST_MIN_DURATION_SEC } from '@/lib/youtube/discovery';

/**
 * PRD "Continuous Discovery" — the topic half of scheduled runs.
 *
 * The manual pipeline takes a topic ("artificial intelligence") and expands
 * it into search queries. Scheduled runs have no user typing a topic, so this
 * agent derives one from today's mostPopular YouTube videos: it reads the
 * trending titles and returns the 1-3 topics worth mining that day.
 *
 * A heuristic fallback clusters the titles by shared keywords so the
 * scheduled run still works with no LLM provider configured.
 */

const TrendingTopicsSchema = z.object({
  topics: z.array(z.string().min(2).max(120)).min(1).max(20),
  rationale: z.string().max(400).default(''),
});

export type TrendingTopics = z.infer<typeof TrendingTopicsSchema>;

const SYSTEM_PROMPT = `You are the trending-topic researcher for a podcast content intelligence platform.

Your job: read the titles of today's most popular YouTube videos (international/global chart, not any single country) and return the 1-3 broad topics worth mining for long-form podcast content.

Rules:
- Topics must be broad enough to surface LONG-FORM INTERVIEW EPISODES (e.g. "artificial intelligence", "startup funding", "health science"), not the specific trending video itself.
- Prefer topics with a strong long-form podcast ecosystem: business, tech, science, psychology, politics/economics, pop culture deep-dives, true crime, sport analysis. AVOID topics that are mostly short-form viral content (dance challenges, memes, celebrity gossip clips, music releases, gaming highlights).
- Do not invent topics that the titles do not support.
- Return 1-3 topics, ordered by mining priority.

Respond with JSON only, matching exactly:
{
  "topics": ["..."],
  "rationale": "one or two sentences"
}`;

/** Common stopwords (EN + ID) stripped during keyword clustering. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'at', 'by', 'from', 'as',
  'it', 'this', 'that', 'these', 'those', 'his', 'her', 'their', 'our',
  'your', 'my', 'we', 'you', 'they', 'he', 'she', 'i', 'me', 'us',
  'how', 'what', 'why', 'who', 'when', 'where', 'which', 'new', 'top',
  'best', 'vs', 'versus', 'ft', 'feat', 'official', 'video', 'watch',
  'yang', 'dan', 'di', 'ke', 'dari', 'dengan', 'untuk', 'pada', 'ini',
  'itu', 'ada', 'adalah', 'tidak', 'akan', 'bisa', 'dalam', 'saat',
]);

/** Split a title into lowercase keyword tokens. */
function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/**
 * Deterministic fallback used when no trending-topic provider is configured
 * or the LLM call fails.
 *
 * Strategy (podcast-first): trending charts are dominated by Shorts, music
 * and gaming streams, so raw keyword clustering produces junk topics. We:
 *   1. Keep only long-form, non-short-form titles.
 *   2. Cluster by meaningful bigrams/trigrams (not single words).
 *   3. If nothing survives, fall back to evergreen podcast topic seeds that
 *      reliably surface long-form interview episodes.
 */
const PODCAST_TOPIC_SEEDS = [
  'technology and AI',
  'business and startups',
  'health and wellness',
  'science and space',
  'psychology and mindset',
  'pop culture deep dive',
  'true crime',
  'money and investing',
  'sports analysis',
];

export function fallbackTrendingTopics(videos: VideoItem[], maxTopics = 3): TrendingTopics {
  // Keywords that signal short-form viral content — never good podcast topics.
  const shortFormHints = [
    'shorts', 'viral', 'challenge', 'tiktok', 'reaction', 'meme',
    'clip', 'highlights', 'mv', 'official', 'trailer', 'live', 'remix',
    'stream', 'gameplay', 'fncs', 'fortnite', 'minecraft', 'walkthrough',
    'direct', 'reveal', 'letra', 'lyrics', 'live stream',
  ];

  const phraseCounts = new Map<string, number>();

  for (const video of videos) {
    // Only long-form videos can be podcast episodes — skip Shorts/music/trailers.
    const durationSec = parseIsoDuration(video.contentDetails?.duration);
    if (durationSec > 0 && durationSec < PODCAST_MIN_DURATION_SEC) continue;

    const title = video.snippet.title.toLowerCase();
    if (shortFormHints.some((hint) => title.includes(hint))) continue;

    // Cluster by overlapping bigrams: "the future of work" -> ["future work"].
    const tokens = tokenize(title);
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const phrase = `${tokens[i]} ${tokens[i + 1]}`;
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
  }

  const ranked = Array.from(phraseCounts.entries())
    .filter(([, count]) => count >= 2) // shared by >=2 videos = real signal
    .filter(([phrase]) => !shortFormHints.some((hint) => phrase.includes(hint)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTopics)
    .map(([phrase]) => phrase);

  if (ranked.length >= 1) {
    return {
      topics: ranked,
      rationale:
        'Heuristic fallback: long-form bigram clusters shared across >=2 trending titles.',
    };
  }

  return {
    topics: PODCAST_TOPIC_SEEDS.slice(0, maxTopics),
    rationale:
      'Heuristic fallback: trending lacked long-form material, using evergreen podcast topic seeds.',
  };
}

export interface TrendingTopicsRequest {
  videos: VideoItem[];
  maxTopics?: number;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
}

export interface TrendingTopicsResult {
  plan: TrendingTopics;
  /** True when an LLM produced the plan; false for the deterministic fallback. */
  aiGenerated: boolean;
  warnings: string[];
}

export async function planTrendingTopics(
  request: TrendingTopicsRequest,
): Promise<TrendingTopicsResult> {
  const maxTopics = Math.max(1, Math.min(20, request.maxTopics ?? 3));
  const warnings: string[] = [];

  if (!isAgentActive('trending_topic', request.overrides)) {
    return {
      plan: fallbackTrendingTopics(request.videos, maxTopics),
      aiGenerated: false,
      warnings,
    };
  }

  const titles = request.videos.map((video) => `- ${video.snippet.title}`).join('\n');

  try {
    const { data } = await runJsonAgent({
      role: 'trending_topic',
      system: SYSTEM_PROMPT,
      user: `Today's mostPopular titles:\n${titles}\n\nReturn at most ${maxTopics} topics.`,
      parse: (value) => TrendingTopicsSchema.parse(value),
      overrides: request.overrides,
      ledger: request.ledger,
      signal: request.signal,
    });

    return {
      plan: {
        ...data,
        topics: data.topics.slice(0, maxTopics),
      },
      aiGenerated: true,
      warnings,
    };
  } catch (error) {
    warnings.push(
      `Trending topic agent unavailable, using heuristic keyword clustering: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return {
      plan: fallbackTrendingTopics(request.videos, maxTopics),
      aiGenerated: false,
      warnings,
    };
  }
}
