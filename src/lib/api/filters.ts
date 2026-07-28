import { isClipCategory, type ClipCategory } from '@/lib/domain/categories';
import { PRIORITY_TIERS, type PriorityTier } from '@/lib/domain/thresholds';
import type { ClipListFilters, ClipStatus } from '@/lib/db/repositories/clips';
import type { EpisodeAnalysisStatus, EpisodeListFilters } from '@/lib/db/repositories/episodes';
import { csvList } from './http';

/**
 * Translate validated query parameters into repository filters.
 *
 * Shared by `/api/clips` and `/api/export` so an export always contains exactly
 * the rows the user was looking at when they clicked the button.
 */

const CLIP_STATUSES: readonly ClipStatus[] = ['new', 'approved', 'rejected', 'published'];
const EPISODE_STATUSES: readonly EpisodeAnalysisStatus[] = [
  'discovered',
  'skipped',
  'analysed',
  'failed',
];

export interface ClipQueryInput {
  tier?: string | string[];
  category?: string | string[];
  status?: string | string[];
  videoId?: string;
  channelId?: string;
  runId?: number;
  minScore?: number;
  minConfidence?: number;
  search?: string;
  since?: string;
  sort?: 'score' | 'confidence' | 'recent' | 'duration';
  limit?: number;
  offset?: number;
}

export function toClipFilters(query: ClipQueryInput): ClipListFilters {
  const tiers = csvList(query.tier)?.filter((value): value is PriorityTier =>
    (PRIORITY_TIERS as readonly string[]).includes(value),
  );

  const categories = csvList(query.category)?.filter((value): value is ClipCategory =>
    isClipCategory(value),
  );

  const statuses = csvList(query.status)?.filter((value): value is ClipStatus =>
    (CLIP_STATUSES as readonly string[]).includes(value),
  );

  return {
    tiers: tiers && tiers.length > 0 ? tiers : undefined,
    categories: categories && categories.length > 0 ? categories : undefined,
    statuses: statuses && statuses.length > 0 ? statuses : undefined,
    videoId: query.videoId,
    channelId: query.channelId,
    runId: query.runId,
    minScore: query.minScore,
    minConfidence: query.minConfidence,
    search: query.search,
    createdSince: query.since,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  };
}

export interface EpisodeQueryInput {
  status?: string | string[];
  channelId?: string;
  topic?: string;
  minOpportunityScore?: number;
  search?: string;
  sort?: 'opportunity' | 'clips' | 'recent' | 'views';
  limit?: number;
  offset?: number;
}

export function toEpisodeFilters(query: EpisodeQueryInput): EpisodeListFilters {
  const status = csvList(query.status)?.filter((value): value is EpisodeAnalysisStatus =>
    (EPISODE_STATUSES as readonly string[]).includes(value),
  );

  return {
    status: status && status.length > 0 ? status : undefined,
    channelId: query.channelId,
    topic: query.topic,
    minOpportunityScore: query.minOpportunityScore,
    search: query.search,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  };
}
