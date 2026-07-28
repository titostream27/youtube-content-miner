import { z } from 'zod';
import { CLIP_CATEGORIES } from '@/lib/domain/categories';
import { PRIORITY_TIERS } from '@/lib/domain/thresholds';
import { AGENT_ROLES } from '@/lib/ai/agents/roles';
import { PROVIDER_CATALOG } from '@/lib/ai/providers/catalog';
import { EXPORT_FORMATS } from '@/lib/export';

/** Shared request schemas, kept next to each other so the API stays coherent. */

const numericString = z.coerce.number().int();

export const providerIdSchema = z.enum([
  ...(PROVIDER_CATALOG.map((provider) => provider.id) as [string, ...string[]]),
  'heuristic',
  'none',
]);

/**
 * Per-role provider override. Lets a caller run discovery on a fast cheap model
 * and clip scoring on a frontier model within the same request.
 */
export const agentOverridesSchema = z
  .record(
    z.enum(AGENT_ROLES),
    z.object({
      provider: providerIdSchema.optional(),
      model: z.string().min(1).max(120).optional(),
    }),
  )
  .optional();

export const runRequestSchema = z
  .object({
    mode: z.enum(['topic', 'tracked_channels', 'archive']),
    topic: z.string().trim().min(2).max(120).optional(),
    channelIds: z.array(z.string().trim().min(2).max(64)).max(25).optional(),
    maxEpisodes: z.number().int().min(1).max(50).optional(),
    episodeScoreThreshold: z.number().int().min(0).max(100).optional(),
    clipScoreThreshold: z.number().int().min(0).max(100).optional(),
    publishedWithinDays: z.number().int().min(1).max(3650).optional(),
    force: z.boolean().optional(),
    agents: agentOverridesSchema,
  })
  .refine((value) => value.mode !== 'topic' || Boolean(value.topic), {
    message: 'topic is required when mode is "topic"',
    path: ['topic'],
  })
  .refine(
    (value) => value.mode !== 'archive' || (value.channelIds?.length ?? 0) > 0,
    { message: 'channelIds must contain one channel when mode is "archive"', path: ['channelIds'] },
  );

export const clipQuerySchema = z.object({
  tier: z.union([z.string(), z.array(z.string())]).optional(),
  category: z.union([z.string(), z.array(z.string())]).optional(),
  status: z.union([z.string(), z.array(z.string())]).optional(),
  videoId: z.string().optional(),
  channelId: z.string().optional(),
  license: z.union([z.string(), z.array(z.string())]).optional(),
  runId: numericString.optional(),
  minScore: numericString.min(0).max(100).optional(),
  minConfidence: numericString.min(0).max(100).optional(),
  search: z.string().optional(),
  since: z.string().optional(),
  sort: z.enum(['score', 'confidence', 'recent', 'duration']).optional(),
  limit: numericString.min(1).max(500).optional(),
  offset: numericString.min(0).optional(),
});

export const episodeQuerySchema = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  channelId: z.string().optional(),
  topic: z.string().optional(),
  minOpportunityScore: numericString.min(0).max(100).optional(),
  search: z.string().optional(),
  sort: z.enum(['opportunity', 'clips', 'recent', 'views']).optional(),
  limit: numericString.min(1).max(200).optional(),
  offset: numericString.min(0).optional(),
});

export const exportQuerySchema = clipQuerySchema.extend({
  format: z.enum([...(EXPORT_FORMATS.map((entry) => entry.format) as ['csv', 'txt'])]),
});

export const clipUpdateSchema = z.object({
  status: z.enum(['new', 'approved', 'rejected', 'published']).optional(),
  feedback: z
    .object({
      verdict: z.enum(['agree', 'disagree', 'published', 'rejected']),
      note: z.string().max(1000).optional(),
    })
    .optional(),
});

export const trackChannelSchema = z.object({
  /** Channel ID, URL, @handle or show name. */
  query: z.string().trim().min(2).max(200),
  label: z.string().trim().max(120).optional(),
});

export const analyzeEpisodeSchema = z.object({
  clipScoreThreshold: z.number().int().min(0).max(100).optional(),
  forceTranscriptRefresh: z.boolean().optional(),
  agents: agentOverridesSchema,
});

export const CLIP_CATEGORY_VALUES = CLIP_CATEGORIES;
export const PRIORITY_TIER_VALUES = PRIORITY_TIERS;
