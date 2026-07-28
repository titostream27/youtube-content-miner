import { z } from 'zod';
import { isAgentActive, runJsonAgent, type AgentOverrides, type UsageLedger } from '../client';

/**
 * PRD Step 1 - the research half of AI Podcast Discovery.
 *
 * A raw topic makes a poor search query. Typing "AI" into YouTube returns
 * explainer channels and news clips, not the long-form interviews we want to
 * mine. A human researcher would instead search for the shows and the phrasings
 * where these conversations actually happen.
 *
 * This agent does that expansion. Each generated query costs 100 units of
 * YouTube quota, so the count is capped hard and the agent is instructed to
 * return queries that do not overlap.
 */

const DiscoveryPlanSchema = z.object({
  searchQueries: z.array(z.string().min(2).max(120)).min(1).max(6),
  channelHints: z.array(z.string().min(2).max(120)).max(10).default([]),
  relatedTopics: z.array(z.string().min(2).max(60)).max(10).default([]),
  rationale: z.string().max(600).default(''),
});

export type DiscoveryPlan = z.infer<typeof DiscoveryPlanSchema>;

const SYSTEM_PROMPT = `You are the discovery researcher for a podcast content intelligence platform.

Your job: turn a broad topic into the YouTube search queries a professional podcast researcher would actually run to find LONG-FORM INTERVIEW EPISODES worth mining for short-form clips.

Rules:
- Target full episodes and interviews, never Shorts, compilations, reaction videos, news bulletins or clip-farm re-uploads.
- Each query must find a DIFFERENT slice of the space. Do not return near-duplicates of the same phrasing.
- Prefer queries that combine the topic with conversation formats ("podcast", "interview", "in conversation", "full episode") or with the specific sub-communities that discuss it.
- channelHints should name real, well-known shows likely to cover the topic. Leave the array empty rather than inventing channels.
- relatedTopics are adjacent topics worth a separate run later.

Respond with JSON only, matching exactly:
{
  "searchQueries": ["..."],
  "channelHints": ["..."],
  "relatedTopics": ["..."],
  "rationale": "one or two sentences"
}`;

export interface DiscoveryPlanRequest {
  topic: string;
  /** Hard cap on generated queries. Each one costs 100 YouTube quota units. */
  maxQueries?: number;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
}

export interface DiscoveryPlanResult {
  plan: DiscoveryPlan;
  /** True when an LLM produced the plan; false for the deterministic fallback. */
  aiGenerated: boolean;
  warnings: string[];
}

/**
 * Deterministic fallback used when no discovery provider is configured or the
 * call fails. It applies the same expansion heuristics a researcher would,
 * just without the topic-specific knowledge.
 */
export function fallbackDiscoveryPlan(topic: string, maxQueries: number): DiscoveryPlan {
  const clean = topic.trim();
  const candidates = [
    `${clean} podcast full episode`,
    `${clean} interview long form`,
    `${clean} in conversation`,
    `${clean} podcast 2026`,
  ];

  return {
    searchQueries: candidates.slice(0, Math.max(1, maxQueries)),
    channelHints: [],
    relatedTopics: [],
    rationale: 'Heuristic expansion: topic combined with long-form conversation formats.',
  };
}

export async function planDiscovery(
  request: DiscoveryPlanRequest,
): Promise<DiscoveryPlanResult> {
  const maxQueries = Math.max(1, Math.min(4, request.maxQueries ?? 3));
  const warnings: string[] = [];

  if (!isAgentActive('discovery', request.overrides)) {
    return {
      plan: fallbackDiscoveryPlan(request.topic, maxQueries),
      aiGenerated: false,
      warnings,
    };
  }

  try {
    const { data } = await runJsonAgent({
      role: 'discovery',
      system: SYSTEM_PROMPT,
      user: `Topic: ${request.topic}\n\nReturn at most ${maxQueries} search queries.`,
      parse: (value) => DiscoveryPlanSchema.parse(value),
      overrides: request.overrides,
      ledger: request.ledger,
      signal: request.signal,
    });

    return {
      plan: {
        ...data,
        searchQueries: data.searchQueries.slice(0, maxQueries),
      },
      aiGenerated: true,
      warnings,
    };
  } catch (error) {
    warnings.push(
      `Discovery agent unavailable, using heuristic query expansion: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return {
      plan: fallbackDiscoveryPlan(request.topic, maxQueries),
      aiGenerated: false,
      warnings,
    };
  }
}
