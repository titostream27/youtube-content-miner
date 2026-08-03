import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 3 (Master Task Brief §26/§27) — analytics snapshots + prediction
 * vs actual comparison.
 *
 * Snapshots are append-only time-series rows (never overwritten) so trend
 * computation stays honest across 24h/72h/7d/28d windows.
 */

export interface AnalyticsSnapshotInput {
  clipId: number;
  platform?: string;
  snapshotWindowHours: number; // 24 | 72 | 168 | 672
  capturedAt?: string;
  views: number;
  viewedRate?: number | null;
  avgViewDurationSec?: number | null;
  avgPercentageViewed?: number | null;
  retention1s?: number | null;
  retention3s?: number | null;
  retention5s?: number | null;
  retention10s?: number | null;
  likes?: number;
  comments?: number;
  shares?: number;
  subscriberGain?: number;
  trafficSource?: string | null;
  topCountry?: string | null;
}

export interface AnalyticsSnapshot extends AnalyticsSnapshotInput {
  id: number;
  capturedAt: string;
  createdAt: string;
}

interface SnapshotRow {
  id: number;
  clip_id: number;
  platform: string;
  snapshot_window_hours: number;
  captured_at: string;
  views: number;
  viewed_rate: number | null;
  avg_view_duration_sec: number | null;
  avg_percentage_viewed: number | null;
  retention_1s: number | null;
  retention_3s: number | null;
  retention_5s: number | null;
  retention_10s: number | null;
  likes: number;
  comments: number;
  shares: number;
  subscriber_gain: number;
  traffic_source: string | null;
  top_country: string | null;
  created_at: string;
}

function mapRow(r: SnapshotRow): AnalyticsSnapshot {
  return {
    id: r.id,
    clipId: r.clip_id,
    platform: r.platform,
    snapshotWindowHours: r.snapshot_window_hours,
    capturedAt: r.captured_at,
    views: r.views,
    viewedRate: r.viewed_rate,
    avgViewDurationSec: r.avg_view_duration_sec,
    avgPercentageViewed: r.avg_percentage_viewed,
    retention1s: r.retention_1s,
    retention3s: r.retention_3s,
    retention5s: r.retention_5s,
    retention10s: r.retention_10s,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    subscriberGain: r.subscriber_gain,
    trafficSource: r.traffic_source,
    topCountry: r.top_country,
    createdAt: r.created_at,
  };
}

export function insertAnalyticsSnapshot(input: AnalyticsSnapshotInput): AnalyticsSnapshot {
  const now = nowIso();
  const capturedAt = input.capturedAt ?? now;
  getDb()
    .prepare(
      `INSERT INTO analytics_snapshots (
         clip_id, platform, snapshot_window_hours, captured_at,
         views, viewed_rate, avg_view_duration_sec, avg_percentage_viewed,
         retention_1s, retention_3s, retention_5s, retention_10s,
         likes, comments, shares, subscriber_gain,
         traffic_source, top_country, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.clipId,
      input.platform ?? 'youtube',
      input.snapshotWindowHours,
      capturedAt,
      input.views,
      input.viewedRate ?? null,
      input.avgViewDurationSec ?? null,
      input.avgPercentageViewed ?? null,
      input.retention1s ?? null,
      input.retention3s ?? null,
      input.retention5s ?? null,
      input.retention10s ?? null,
      input.likes ?? 0,
      input.comments ?? 0,
      input.shares ?? 0,
      input.subscriberGain ?? 0,
      input.trafficSource ?? null,
      input.topCountry ?? null,
      now,
    );
  const row = getDb()
    .prepare('SELECT * FROM analytics_snapshots WHERE id = last_insert_rowid()')
    .get() as SnapshotRow;
  return mapRow(row);
}

export function getLatestAnalytics(clipId: number): AnalyticsSnapshot | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM analytics_snapshots WHERE clip_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(clipId) as SnapshotRow | undefined;
  return row ? mapRow(row) : null;
}

export function listAnalyticsSnapshots(clipId: number, limit = 50): AnalyticsSnapshot[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM analytics_snapshots WHERE clip_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(clipId, limit) as SnapshotRow[];
  return rows.map(mapRow);
}

export function listAnalyticsByWindow(clipId: number, windowHours: number): AnalyticsSnapshot[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM analytics_snapshots WHERE clip_id = ? AND snapshot_window_hours = ? ORDER BY captured_at ASC',
    )
    .all(clipId, windowHours) as SnapshotRow[];
  return rows.map(mapRow);
}

export function listClipsWithAnalytics(): number[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT clip_id FROM analytics_snapshots ORDER BY clip_id')
    .all() as { clip_id: number }[];
  return rows.map((r) => r.clip_id);
}

export function countAnalyticsClips(): number {
  const row = getDb()
    .prepare('SELECT COUNT(DISTINCT clip_id) AS c FROM analytics_snapshots')
    .get() as { c: number };
  return row.c;
}
