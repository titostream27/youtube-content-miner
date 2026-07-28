import type {
  EpisodeCandidate,
  VideoLicense,
  EpisodeFactorScores,
  EpisodeOpportunity,
  TranscriptSource,
} from '@/lib/domain/types';
import {
  fromJson,
  fromSqliteBool,
  getDb,
  nowIso,
  toJson,
  toSqliteBool,
} from '../client';

export type EpisodeAnalysisStatus = 'discovered' | 'skipped' | 'analysed' | 'failed';

export interface EpisodeRecord {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSeconds: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  thumbnailUrl: string | null;
  tags: string[];
  hasCaptions: boolean | null;
  license: VideoLicense;
  embeddable: boolean | null;
  opportunityScore: number | null;
  opportunityFactors: EpisodeFactorScores | null;
  opportunityReasons: string[];
  analysisStatus: EpisodeAnalysisStatus;
  skipReason: string | null;
  transcriptSource: TranscriptSource | null;
  segmentCount: number;
  clipCount: number;
  topic: string | null;
  lastRunId: number | null;
  discoveredAt: string;
  analysedAt: string | null;
}

interface EpisodeRow {
  video_id: string;
  channel_id: string;
  channel_title: string;
  title: string;
  description: string;
  published_at: string;
  duration_seconds: number;
  view_count: number;
  like_count: number;
  comment_count: number;
  thumbnail_url: string | null;
  tags: string;
  has_captions: number | null;
  license: string | null;
  embeddable: number | null;
  opportunity_score: number | null;
  opportunity_factors: string | null;
  opportunity_reasons: string;
  analysis_status: string;
  skip_reason: string | null;
  transcript_source: string | null;
  segment_count: number;
  clip_count: number;
  topic: string | null;
  last_run_id: number | null;
  discovered_at: string;
  analysed_at: string | null;
}

function mapEpisode(row: EpisodeRow): EpisodeRecord {
  return {
    videoId: row.video_id,
    channelId: row.channel_id,
    channelTitle: row.channel_title,
    title: row.title,
    description: row.description,
    publishedAt: row.published_at,
    durationSeconds: row.duration_seconds,
    viewCount: row.view_count,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    thumbnailUrl: row.thumbnail_url,
    tags: fromJson<string[]>(row.tags, []),
    hasCaptions: fromSqliteBool(row.has_captions),
    license: row.license === 'creativeCommon' || row.license === 'youtube' ? row.license : null,
    embeddable: fromSqliteBool(row.embeddable),
    opportunityScore: row.opportunity_score,
    opportunityFactors: row.opportunity_factors
      ? fromJson<EpisodeFactorScores | null>(row.opportunity_factors, null)
      : null,
    opportunityReasons: fromJson<string[]>(row.opportunity_reasons, []),
    analysisStatus: row.analysis_status as EpisodeAnalysisStatus,
    skipReason: row.skip_reason,
    transcriptSource: row.transcript_source as TranscriptSource | null,
    segmentCount: row.segment_count,
    clipCount: row.clip_count,
    topic: row.topic,
    lastRunId: row.last_run_id,
    discoveredAt: row.discovered_at,
    analysedAt: row.analysed_at,
  };
}

/**
 * Persist a discovered episode together with its Episode Opportunity Score.
 *
 * Re-discovering an episode refreshes the volatile stats (views, likes,
 * comments) and the opportunity score, but never resets analysis state - we do
 * not want a second run to forget that we already extracted clips.
 */
export function upsertDiscoveredEpisode(params: {
  candidate: EpisodeCandidate;
  opportunity: EpisodeOpportunity;
  topic: string | null;
  runId: number | null;
}): void {
  const { candidate, opportunity, topic, runId } = params;

  getDb()
    .prepare(
      `INSERT INTO episodes (
         video_id, channel_id, channel_title, title, description, published_at,
         duration_seconds, view_count, like_count, comment_count, thumbnail_url,
         tags, has_captions, license, embeddable, opportunity_score, opportunity_factors,
         opportunity_reasons, analysis_status, skip_reason, topic, last_run_id,
         discovered_at
       ) VALUES (
         @videoId, @channelId, @channelTitle, @title, @description, @publishedAt,
         @durationSeconds, @viewCount, @likeCount, @commentCount, @thumbnailUrl,
         @tags, @hasCaptions, @license, @embeddable, @opportunityScore, @opportunityFactors,
         @opportunityReasons, @analysisStatus, @skipReason, @topic, @runId,
         @discoveredAt
       )
       ON CONFLICT (video_id) DO UPDATE SET
         title               = excluded.title,
         description         = excluded.description,
         view_count          = excluded.view_count,
         like_count          = excluded.like_count,
         comment_count       = excluded.comment_count,
         thumbnail_url       = excluded.thumbnail_url,
         tags                = excluded.tags,
         has_captions        = excluded.has_captions,
         license             = excluded.license,
         embeddable          = excluded.embeddable,
         opportunity_score   = excluded.opportunity_score,
         opportunity_factors = excluded.opportunity_factors,
         opportunity_reasons = excluded.opportunity_reasons,
         -- Keep the topic that originally surfaced the episode, for provenance.
         topic               = COALESCE(episodes.topic, excluded.topic),
         last_run_id         = excluded.last_run_id,
         -- Preserve a completed analysis across re-discovery.
         analysis_status     = CASE
                                 WHEN episodes.analysis_status = 'analysed' THEN 'analysed'
                                 ELSE excluded.analysis_status
                               END,
         skip_reason         = CASE
                                 WHEN episodes.analysis_status = 'analysed' THEN episodes.skip_reason
                                 ELSE excluded.skip_reason
                               END`,
    )
    .run({
      videoId: candidate.videoId,
      channelId: candidate.channelId,
      channelTitle: candidate.channelTitle,
      title: candidate.title,
      description: candidate.description,
      publishedAt: candidate.publishedAt,
      durationSeconds: candidate.durationSeconds,
      viewCount: candidate.viewCount,
      likeCount: candidate.likeCount,
      commentCount: candidate.commentCount,
      thumbnailUrl: candidate.thumbnailUrl,
      tags: toJson(candidate.tags),
      hasCaptions: toSqliteBool(candidate.hasCaptions),
      license: candidate.license,
      embeddable: toSqliteBool(candidate.embeddable),
      opportunityScore: opportunity.score,
      opportunityFactors: toJson(opportunity.factors),
      opportunityReasons: toJson(opportunity.reasons),
      analysisStatus: opportunity.eligible ? 'discovered' : 'skipped',
      skipReason: opportunity.skipReason,
      topic,
      runId,
      discoveredAt: nowIso(),
    });
}

export function markEpisodeAnalysed(params: {
  videoId: string;
  transcriptSource: TranscriptSource;
  segmentCount: number;
  clipCount: number;
}): void {
  getDb()
    .prepare(
      `UPDATE episodes SET
         analysis_status   = 'analysed',
         skip_reason       = NULL,
         transcript_source = @transcriptSource,
         segment_count     = @segmentCount,
         clip_count        = @clipCount,
         analysed_at       = @analysedAt
       WHERE video_id = @videoId`,
    )
    .run({ ...params, analysedAt: nowIso() });
}

/**
 * Mark an episode as skipped.
 *
 * Never downgrades a completed analysis. The same episode is routinely
 * rediscovered by a later run on an unrelated topic, where it legitimately fails
 * the relevance gate - but it still has clips in the library, and flipping it to
 * "skipped" would orphan them and corrupt the dashboard counts.
 */
export function markEpisodeSkipped(videoId: string, skipReason: string): void {
  getDb()
    .prepare(
      `UPDATE episodes
          SET analysis_status = 'skipped', skip_reason = ?
        WHERE video_id = ? AND analysis_status <> 'analysed'`,
    )
    .run(skipReason, videoId);
}

export function markEpisodeFailed(videoId: string, error: string): void {
  getDb()
    .prepare(`UPDATE episodes SET analysis_status = 'failed', skip_reason = ? WHERE video_id = ?`)
    .run(error, videoId);
}

export function getEpisode(videoId: string): EpisodeRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM episodes WHERE video_id = ?')
    .get(videoId) as EpisodeRow | undefined;
  return row ? mapEpisode(row) : null;
}

export type EpisodeSort = 'opportunity' | 'clips' | 'recent' | 'views';

export interface EpisodeListFilters {
  status?: EpisodeAnalysisStatus[];
  channelId?: string;
  topic?: string;
  minOpportunityScore?: number;
  search?: string;
  sort?: EpisodeSort;
  limit?: number;
  offset?: number;
}

const EPISODE_SORT_SQL: Record<EpisodeSort, string> = {
  opportunity: 'COALESCE(opportunity_score, -1) DESC, discovered_at DESC',
  clips: 'clip_count DESC, COALESCE(opportunity_score, -1) DESC',
  recent: 'published_at DESC',
  views: 'view_count DESC',
};

export function listEpisodes(filters: EpisodeListFilters = {}): EpisodeRecord[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.status && filters.status.length > 0) {
    const placeholders = filters.status.map((_, index) => `@status${index}`);
    conditions.push(`analysis_status IN (${placeholders.join(', ')})`);
    filters.status.forEach((status, index) => {
      params[`status${index}`] = status;
    });
  }

  if (filters.channelId) {
    conditions.push('channel_id = @channelId');
    params.channelId = filters.channelId;
  }

  if (filters.topic) {
    conditions.push('topic = @topic');
    params.topic = filters.topic;
  }

  if (typeof filters.minOpportunityScore === 'number') {
    conditions.push('COALESCE(opportunity_score, 0) >= @minOpportunityScore');
    params.minOpportunityScore = filters.minOpportunityScore;
  }

  if (filters.search && filters.search.trim().length > 0) {
    conditions.push('(title LIKE @search OR channel_title LIKE @search)');
    params.search = `%${filters.search.trim()}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = EPISODE_SORT_SQL[filters.sort ?? 'opportunity'];

  params.limit = filters.limit ?? 50;
  params.offset = filters.offset ?? 0;

  const rows = getDb()
    .prepare(
      `SELECT * FROM episodes ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`,
    )
    .all(params) as EpisodeRow[];

  return rows.map(mapEpisode);
}

export function countEpisodes(filters: Pick<EpisodeListFilters, 'status' | 'channelId'> = {}): number {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.status && filters.status.length > 0) {
    const placeholders = filters.status.map((_, index) => `@status${index}`);
    conditions.push(`analysis_status IN (${placeholders.join(', ')})`);
    filters.status.forEach((status, index) => {
      params[`status${index}`] = status;
    });
  }

  if (filters.channelId) {
    conditions.push('channel_id = @channelId');
    params.channelId = filters.channelId;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS total FROM episodes ${where}`)
    .get(params) as { total: number };

  return row.total;
}

/** Video IDs already analysed, so repeat runs skip them for free. */
export function findAnalysedVideoIds(videoIds: string[]): Set<string> {
  if (videoIds.length === 0) return new Set();

  const placeholders = videoIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT video_id FROM episodes
        WHERE analysis_status = 'analysed' AND video_id IN (${placeholders})`,
    )
    .all(...videoIds) as { video_id: string }[];

  return new Set(rows.map((row) => row.video_id));
}


/**
 * Rebuild the discovery-shaped candidate from a stored episode.
 *
 * Lets a single episode be re-analysed (after a scoring model change, or when a
 * caption track appears later) without paying for discovery again.
 */
export function episodeRecordToCandidate(record: EpisodeRecord): EpisodeCandidate {
  return {
    videoId: record.videoId,
    title: record.title,
    description: record.description,
    channelId: record.channelId,
    channelTitle: record.channelTitle,
    publishedAt: record.publishedAt,
    durationSeconds: record.durationSeconds,
    viewCount: record.viewCount,
    likeCount: record.likeCount,
    commentCount: record.commentCount,
    thumbnailUrl: record.thumbnailUrl,
    tags: record.tags,
    hasCaptions: record.hasCaptions,
    license: record.license,
    embeddable: record.embeddable,
    channel: null,
  };
}
