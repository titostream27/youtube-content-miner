import { z } from 'zod';
import { insertAnalyticsSnapshot, listClipsWithAnalytics } from '@/lib/db/repositories/analytics';
import { insertEpisodeMetricSnapshot } from '@/lib/db/repositories/episode-metrics';
import { ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

const SnapshotSchema = z.object({
  clip_id: z.number().int(),
  platform: z.string().optional(),
  snapshot_window_hours: z.number().int().min(1).max(24 * 30),
  captured_at: z.string().optional(),
  views: z.number().int().min(0).default(0),
  viewed_rate: z.number().min(0).max(1).optional(),
  avg_view_duration_sec: z.number().min(0).optional(),
  avg_percentage_viewed: z.number().min(0).max(1).optional(),
  retention_1s: z.number().min(0).max(1).optional(),
  retention_3s: z.number().min(0).max(1).optional(),
  retention_5s: z.number().min(0).max(1).optional(),
  retention_10s: z.number().min(0).max(1).optional(),
  likes: z.number().int().min(0).optional(),
  comments: z.number().int().min(0).optional(),
  shares: z.number().int().min(0).optional(),
  subscriber_gain: z.number().int().optional(),
  traffic_source: z.string().optional(),
  top_country: z.string().optional(),
});

const SyncBodySchema = z.object({
  snapshots: z.array(SnapshotSchema).min(1),
  episode_metrics: z
    .array(
      z.object({
        video_id: z.string(),
        view_count: z.number().int().min(0),
        like_count: z.number().int().min(0).optional(),
        comment_count: z.number().int().min(0).optional(),
        captured_at: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * POST /api/analytics/sync
 *
 * Phase 3 (brief §26/§39) — ingest one or more analytics snapshots.
 * Snapshots are append-only; the same clip+window+time can be captured
 * repeatedly without overwriting (trend history preserved).
 *
 * Also accepts episode_metrics for trend scoring (brief §30).
 */
export async function POST(request: Request) {
  const parsed = await parseJsonBody(request, SyncBodySchema);
  if (parsed.error) return parsed.error;

  const inserted = parsed.data.snapshots.map((s) =>
    insertAnalyticsSnapshot({
      clipId: s.clip_id,
      platform: s.platform,
      snapshotWindowHours: s.snapshot_window_hours,
      capturedAt: s.captured_at,
      views: s.views,
      viewedRate: s.viewed_rate ?? null,
      avgViewDurationSec: s.avg_view_duration_sec ?? null,
      avgPercentageViewed: s.avg_percentage_viewed ?? null,
      retention1s: s.retention_1s ?? null,
      retention3s: s.retention_3s ?? null,
      retention5s: s.retention_5s ?? null,
      retention10s: s.retention_10s ?? null,
      likes: s.likes ?? 0,
      comments: s.comments ?? 0,
      shares: s.shares ?? 0,
      subscriberGain: s.subscriber_gain ?? 0,
      trafficSource: s.traffic_source ?? null,
      topCountry: s.top_country ?? null,
    }),
  );

  let episodeInserted = 0;
  for (const em of parsed.data.episode_metrics ?? []) {
    insertEpisodeMetricSnapshot({
      videoId: em.video_id,
      viewCount: em.view_count,
      likeCount: em.like_count,
      commentCount: em.comment_count,
      capturedAt: em.captured_at,
    });
    episodeInserted += 1;
  }

  return ok({
    inserted: inserted.length,
    episodeMetricsInserted: episodeInserted,
    clipsWithAnalytics: listClipsWithAnalytics().length,
  });
}
