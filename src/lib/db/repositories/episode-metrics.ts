import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 3 (Master Task Brief §30) — episode metric snapshots for
 * trend / evergreen / breakout scoring. Append-only per capture.
 */

export interface EpisodeMetricSnapshotInput {
  videoId: string;
  viewCount: number;
  likeCount?: number;
  commentCount?: number;
  capturedAt?: string;
}

export interface EpisodeMetricSnapshot extends EpisodeMetricSnapshotInput {
  id: number;
  capturedAt: string;
}

interface Row {
  id: number;
  video_id: string;
  view_count: number;
  like_count: number | null;
  comment_count: number | null;
  captured_at: string;
}

export function insertEpisodeMetricSnapshot(input: EpisodeMetricSnapshotInput): EpisodeMetricSnapshot {
  const capturedAt = input.capturedAt ?? nowIso();
  getDb()
    .prepare(
      `INSERT INTO episode_metric_snapshots (video_id, view_count, like_count, comment_count, captured_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.videoId, input.viewCount, input.likeCount ?? null, input.commentCount ?? null, capturedAt);
  const row = getDb()
    .prepare('SELECT * FROM episode_metric_snapshots WHERE id = last_insert_rowid()')
    .get() as Row;
  return {
    id: row.id,
    videoId: row.video_id,
    viewCount: row.view_count,
    likeCount: row.like_count ?? undefined,
    commentCount: row.comment_count ?? undefined,
    capturedAt: row.captured_at,
  };
}

export interface TrendScore {
  trendScore: number;
  evergreenScore: number;
  breakoutScore: number;
  viewsPerHour: number;
  likesPerHour: number;
  acceleration: number;
}

export function listEpisodeMetricSnapshots(videoId: string): EpisodeMetricSnapshot[] {
  const rows = getDb()
    .prepare('SELECT * FROM episode_metric_snapshots WHERE video_id = ? ORDER BY captured_at ASC')
    .all(videoId) as Row[];
  return rows.map((r) => ({
    id: r.id,
    videoId: r.video_id,
    viewCount: r.view_count,
    likeCount: r.like_count ?? undefined,
    commentCount: r.comment_count ?? undefined,
    capturedAt: r.captured_at,
  }));
}

/**
 * Compute trend/evergreen/breakout from two snapshots (oldest -> newest).
 * - viewsPerHour: growth rate over the interval.
 * - acceleration: second derivative (growth of growth).
 * - trendScore: recency-weighted velocity.
 * - evergreenScore: low decay rate over long window.
 * - breakoutScore: velocity x acceleration spike.
 */
export function computeTrendScores(
  older: EpisodeMetricSnapshot | null,
  newer: EpisodeMetricSnapshot | null,
  hoursBetween = 24,
): TrendScore {
  if (!older || !newer || hoursBetween <= 0) {
    return { trendScore: 0, evergreenScore: 0, breakoutScore: 0, viewsPerHour: 0, likesPerHour: 0, acceleration: 0 };
  }
  const viewsPerHour = Math.max(0, (newer.viewCount - older.viewCount) / hoursBetween);
  const likesPerHour = Math.max(0, ((newer.likeCount ?? 0) - (older.likeCount ?? 0)) / hoursBetween);
  const totalViews = Math.max(1, newer.viewCount);
  const decay = Math.max(0, 1 - (older.viewCount / totalViews));
  const acceleration = viewsPerHour > 1 ? (viewsPerHour - Math.max(0, (older.viewCount - 0) / Math.max(1, hoursBetween * 2))) / viewsPerHour : 0;
  return {
    trendScore: Math.min(100, Math.round(viewsPerHour * 5 + likesPerHour * 20)),
    evergreenScore: Math.min(100, Math.round(decay * 100)),
    breakoutScore: Math.min(100, Math.round(viewsPerHour * (1 + Math.max(0, acceleration)) * 6)),
    viewsPerHour: Math.round(viewsPerHour * 10) / 10,
    likesPerHour: Math.round(likesPerHour * 10) / 10,
    acceleration: Math.round(acceleration * 100) / 100,
  };
}
