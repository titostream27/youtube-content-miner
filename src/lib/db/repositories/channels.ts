import type { ChannelSummary } from '@/lib/domain/types';
import { getDb, nowIso } from '../client';

interface ChannelRow {
  channel_id: string;
  title: string;
  handle: string | null;
  thumbnail_url: string | null;
  subscriber_count: number | null;
  video_count: number | null;
  view_count: number | null;
  updated_at: string;
}

function mapChannel(row: ChannelRow): ChannelSummary {
  return {
    channelId: row.channel_id,
    title: row.title,
    handle: row.handle,
    thumbnailUrl: row.thumbnail_url,
    subscriberCount: row.subscriber_count,
    videoCount: row.video_count,
    viewCount: row.view_count,
  };
}

export function upsertChannel(channel: ChannelSummary): void {
  getDb()
    .prepare(
      `INSERT INTO channels (
         channel_id, title, handle, thumbnail_url,
         subscriber_count, video_count, view_count, updated_at
       ) VALUES (
         @channelId, @title, @handle, @thumbnailUrl,
         @subscriberCount, @videoCount, @viewCount, @updatedAt
       )
       ON CONFLICT (channel_id) DO UPDATE SET
         title            = excluded.title,
         handle           = excluded.handle,
         thumbnail_url    = excluded.thumbnail_url,
         subscriber_count = excluded.subscriber_count,
         video_count      = excluded.video_count,
         view_count       = excluded.view_count,
         updated_at       = excluded.updated_at`,
    )
    .run({
      channelId: channel.channelId,
      title: channel.title,
      handle: channel.handle,
      thumbnailUrl: channel.thumbnailUrl,
      subscriberCount: channel.subscriberCount,
      videoCount: channel.videoCount,
      viewCount: channel.viewCount,
      updatedAt: nowIso(),
    });
}

export function getChannel(channelId: string): ChannelSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM channels WHERE channel_id = ?')
    .get(channelId) as ChannelRow | undefined;
  return row ? mapChannel(row) : null;
}

export function listChannels(): ChannelSummary[] {
  const rows = getDb().prepare('SELECT * FROM channels ORDER BY title').all() as ChannelRow[];
  return rows.map(mapChannel);
}

/* -------------------------------------------------------------------------- */
/* PRD Mode B - tracked channels                                              */
/* -------------------------------------------------------------------------- */

export interface TrackedChannel {
  channelId: string;
  label: string | null;
  active: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
  channel: ChannelSummary | null;
  episodeCount: number;
  clipCount: number;
}

interface TrackedChannelRow extends ChannelRow {
  tracked_channel_id: string;
  label: string | null;
  active: number;
  last_checked_at: string | null;
  created_at: string;
  episode_count: number;
  clip_count: number;
}

export function addTrackedChannel(channelId: string, label: string | null = null): void {
  getDb()
    .prepare(
      `INSERT INTO tracked_channels (channel_id, label, active, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (channel_id) DO UPDATE SET
         label  = COALESCE(excluded.label, tracked_channels.label),
         active = 1`,
    )
    .run(channelId, label, nowIso());
}

export function removeTrackedChannel(channelId: string): void {
  getDb().prepare('DELETE FROM tracked_channels WHERE channel_id = ?').run(channelId);
}

export function markTrackedChannelChecked(channelId: string): void {
  getDb()
    .prepare('UPDATE tracked_channels SET last_checked_at = ? WHERE channel_id = ?')
    .run(nowIso(), channelId);
}

export function listTrackedChannels(activeOnly = true): TrackedChannel[] {
  const rows = getDb()
    .prepare(
      `SELECT
         t.channel_id AS tracked_channel_id,
         t.label,
         t.active,
         t.last_checked_at,
         t.created_at,
         c.channel_id,
         c.title,
         c.handle,
         c.thumbnail_url,
         c.subscriber_count,
         c.video_count,
         c.view_count,
         c.updated_at,
         (SELECT COUNT(*) FROM episodes e WHERE e.channel_id = t.channel_id) AS episode_count,
         (SELECT COUNT(*) FROM clips cl
            JOIN episodes e2 ON e2.video_id = cl.video_id
           WHERE e2.channel_id = t.channel_id) AS clip_count
       FROM tracked_channels t
       LEFT JOIN channels c ON c.channel_id = t.channel_id
       ${activeOnly ? 'WHERE t.active = 1' : ''}
       ORDER BY COALESCE(c.title, t.channel_id)`,
    )
    .all() as TrackedChannelRow[];

  return rows.map((row) => ({
    channelId: row.tracked_channel_id,
    label: row.label,
    active: row.active === 1,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    channel: row.channel_id ? mapChannel(row) : null,
    episodeCount: row.episode_count,
    clipCount: row.clip_count,
  }));
}
