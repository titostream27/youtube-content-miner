import { LIBRARY_MIN_SCORE, PRIORITY_TIERS, type PriorityTier } from '@/lib/domain/thresholds';
import type { DashboardStats } from '@/lib/domain/types';
import { getDb } from '../client';

/**
 * Dashboard aggregates.
 *
 * The PRD's dashboard is the product's primary surface: the creator opens it,
 * sees "11 Publish Immediately", and forwards them to the editor. These
 * queries back exactly that view.
 */

export function startOfToday(now = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

export function getDashboardStats(since: string): DashboardStats {
  const db = getDb();

  const discovered = db
    .prepare('SELECT COUNT(*) AS total FROM episodes WHERE discovered_at >= ?')
    .get(since) as { total: number };

  const analysed = db
    .prepare(
      `SELECT COUNT(*) AS total FROM episodes
        WHERE analysis_status = 'analysed' AND analysed_at IS NOT NULL AND analysed_at >= ?`,
    )
    .get(since) as { total: number };

  const clips = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN tier = 'high_priority' THEN 1 ELSE 0 END) AS high_priority,
         SUM(CASE WHEN tier = 'publish_immediately' THEN 1 ELSE 0 END) AS publish_immediately
       FROM clips
       WHERE created_at >= ? AND final_score >= ?`,
    )
    .get(since, LIBRARY_MIN_SCORE) as {
    total: number;
    high_priority: number | null;
    publish_immediately: number | null;
  };

  return {
    podcastsDiscovered: discovered.total,
    episodesAnalysed: analysed.total,
    potentialClips: clips.total,
    highPriority: clips.high_priority ?? 0,
    publishImmediately: clips.publish_immediately ?? 0,
  };
}

function emptyTierCounts(): Record<PriorityTier, number> {
  return PRIORITY_TIERS.reduce(
    (acc, tier) => {
      acc[tier] = 0;
      return acc;
    },
    {} as Record<PriorityTier, number>,
  );
}

export function getTierCounts(since?: string): Record<PriorityTier, number> {
  const counts = emptyTierCounts();

  const rows = (
    since
      ? getDb()
          .prepare('SELECT tier, COUNT(*) AS total FROM clips WHERE created_at >= ? GROUP BY tier')
          .all(since)
      : getDb().prepare('SELECT tier, COUNT(*) AS total FROM clips GROUP BY tier').all()
  ) as { tier: string; total: number }[];

  for (const row of rows) {
    if (row.tier in counts) {
      counts[row.tier as PriorityTier] = row.total;
    }
  }

  return counts;
}

export interface LibraryTotals {
  episodesDiscovered: number;
  episodesAnalysed: number;
  episodesSkipped: number;
  clipsTotal: number;
  clipsInLibrary: number;
  averageScore: number;
  averageConfidence: number;
  hoursMined: number;
  /** Estimated editor hours saved versus manually scrubbing each episode. */
  reviewHoursSaved: number;
}

export function getLibraryTotals(): LibraryTotals {
  const db = getDb();

  const episodes = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN analysis_status = 'analysed' THEN 1 ELSE 0 END) AS analysed,
         SUM(CASE WHEN analysis_status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN analysis_status = 'analysed' THEN duration_seconds ELSE 0 END) AS analysed_seconds
       FROM episodes`,
    )
    .get() as {
    total: number;
    analysed: number | null;
    skipped: number | null;
    analysed_seconds: number | null;
  };

  const clips = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN final_score >= ? THEN 1 ELSE 0 END) AS in_library,
         AVG(final_score) AS avg_score,
         AVG(confidence) AS avg_confidence
       FROM clips`,
    )
    .get(LIBRARY_MIN_SCORE) as {
    total: number;
    in_library: number | null;
    avg_score: number | null;
    avg_confidence: number | null;
  };

  const analysedSeconds = episodes.analysed_seconds ?? 0;
  const hoursMined = analysedSeconds / 3600;

  return {
    episodesDiscovered: episodes.total,
    episodesAnalysed: episodes.analysed ?? 0,
    episodesSkipped: episodes.skipped ?? 0,
    clipsTotal: clips.total,
    clipsInLibrary: clips.in_library ?? 0,
    averageScore: Math.round(clips.avg_score ?? 0),
    averageConfidence: Math.round(clips.avg_confidence ?? 0),
    hoursMined: Math.round(hoursMined * 10) / 10,
    // The PRD's core claim: the editor no longer watches the episode to find
    // moments. We credit the full analysed runtime as time not spent scrubbing.
    reviewHoursSaved: Math.round(hoursMined * 10) / 10,
  };
}

export interface DailyPoint {
  day: string;
  clips: number;
  publishImmediately: number;
}

/** Clip yield per day, for the dashboard trend strip. */
export function getDailyClipTrend(days = 14): DailyPoint[] {
  const rows = getDb()
    .prepare(
      `SELECT
         substr(created_at, 1, 10) AS day,
         COUNT(*) AS clips,
         SUM(CASE WHEN tier = 'publish_immediately' THEN 1 ELSE 0 END) AS publish_immediately
       FROM clips
       GROUP BY day
       ORDER BY day DESC
       LIMIT ?`,
    )
    .all(days) as { day: string; clips: number; publish_immediately: number | null }[];

  return rows
    .map((row) => ({
      day: row.day,
      clips: row.clips,
      publishImmediately: row.publish_immediately ?? 0,
    }))
    .reverse();
}
