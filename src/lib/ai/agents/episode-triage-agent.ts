import { z } from 'zod';
import type { EpisodeCandidate } from '@/lib/domain/types';
import { formatDurationLabel } from '@/lib/youtube/duration';
import { isAgentActive, runJsonAgent, type AgentOverrides, type UsageLedger } from '../client';

/**
 * PRD Step 2 - the semantic half of the Episode Opportunity Score.
 *
 * The deterministic score in `scoring/episode-opportunity.ts` reads numbers:
 * duration, engagement, velocity, term overlap. What it cannot read is meaning.
 * It has no way to know that "The Bottleneck Moved" is an episode about AI, or
 * that an episode whose title matches the topic perfectly is actually a
 * sponsor-heavy Q&A with nothing quotable in it.
 *
 * This agent reads titles and descriptions and returns two judgements which are
 * then blended into the deterministic factors rather than replacing them. The
 * blend matters: a hallucinated 95 should not be able to promote a junk episode
 * on its own, and a model outage should not stop the pipeline.
 */

const TriageItemSchema = z.object({
  videoId: z.string().min(1),
  topicFit: z.number().min(0).max(100),
  expectedClipDensity: z.number().min(0).max(100),
  reason: z.string().max(240).default(''),
  isPodcastEpisode: z.boolean().default(true),
});

const TriageResponseSchema = z.object({
  episodes: z.array(TriageItemSchema).max(60),
});

export interface EpisodeTriageJudgement {
  topicFit: number;
  expectedClipDensity: number;
  reason: string;
  isPodcastEpisode: boolean;
}

const SYSTEM_PROMPT = `You are the episode triage analyst for a podcast content intelligence platform.

For each episode you receive metadata only - never a transcript. Decide, from that metadata alone, whether it is worth paying to transcribe and analyse.

Return for each episode:
- topicFit (0-100): how genuinely relevant the episode is to the requested topic. A title that merely contains the keyword is not a fit. An episode where the topic is the substance of the conversation is.
- expectedClipDensity (0-100): how many self-contained, quotable moments a long-form episode like this typically yields. Interviews with a specific practitioner telling stories score high. Panel news round-ups, Q&A grab-bags, and promotional episodes score low.
- isPodcastEpisode: false for trailers, Shorts compilations, music, livestream VODs with no conversation, or clip re-uploads.
- reason: one short sentence, concrete, referencing what in the metadata drove your judgement.

Be sceptical. Most episodes are average. Reserve scores above 85 for genuinely strong signals.

Respond with JSON only: { "episodes": [ { "videoId": "...", "topicFit": 0, "expectedClipDensity": 0, "isPodcastEpisode": true, "reason": "..." } ] }`;

function describeCandidate(candidate: EpisodeCandidate): string {
  const description = candidate.description
    .replace(/\s+/g, ' ')
    .slice(0, 500);

  return [
    `videoId: ${candidate.videoId}`,
    `title: ${candidate.title}`,
    `channel: ${candidate.channelTitle}`,
    `duration: ${formatDurationLabel(candidate.durationSeconds)}`,
    `views: ${candidate.viewCount.toLocaleString('en-US')}`,
    `comments: ${candidate.commentCount.toLocaleString('en-US')}`,
    `published: ${candidate.publishedAt.slice(0, 10)}`,
    `tags: ${candidate.tags.slice(0, 12).join(', ') || 'none'}`,
    `description: ${description}`,
  ].join('\n');
}

export interface TriageRequest {
  candidates: EpisodeCandidate[];
  topic: string | null;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
}

export interface TriageResult {
  /** Keyed by videoId. Missing entries simply keep their deterministic score. */
  judgements: Map<string, EpisodeTriageJudgement>;
  aiGenerated: boolean;
  warnings: string[];
}

export async function triageEpisodes(request: TriageRequest): Promise<TriageResult> {
  const empty: TriageResult = { judgements: new Map(), aiGenerated: false, warnings: [] };

  if (request.candidates.length === 0) return empty;
  if (!isAgentActive('episode_triage', request.overrides)) return empty;

  const topicLine = request.topic
    ? `Requested topic: ${request.topic}`
    : 'No specific topic - judge general clip potential instead of topical fit, and return topicFit 70 for anything that is a genuine long-form conversation.';

  try {
    const { data } = await runJsonAgent({
      role: 'episode_triage',
      system: SYSTEM_PROMPT,
      user: `${topicLine}\n\nEpisodes:\n\n${request.candidates
        .map(describeCandidate)
        .join('\n\n---\n\n')}`,
      parse: (value) => TriageResponseSchema.parse(value),
      overrides: request.overrides,
      ledger: request.ledger,
      signal: request.signal,
    });

    const judgements = new Map<string, EpisodeTriageJudgement>();
    const knownIds = new Set(request.candidates.map((candidate) => candidate.videoId));

    for (const item of data.episodes) {
      // Ignore hallucinated IDs rather than trusting them.
      if (!knownIds.has(item.videoId)) continue;
      judgements.set(item.videoId, {
        topicFit: item.topicFit,
        expectedClipDensity: item.expectedClipDensity,
        reason: item.reason,
        isPodcastEpisode: item.isPodcastEpisode,
      });
    }

    return { judgements, aiGenerated: true, warnings: [] };
  } catch (error) {
    return {
      ...empty,
      warnings: [
        `Episode triage agent unavailable, using deterministic scoring only: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      ],
    };
  }
}

/**
 * The blend itself lives in `scoring/episode-opportunity.ts` alongside the
 * deterministic factors, so there is exactly one place where an episode's
 * score is decided.
 */
