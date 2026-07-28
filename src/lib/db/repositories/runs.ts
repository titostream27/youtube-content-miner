import type { DiscoveryMode, ScoringEngineName } from '@/lib/domain/types';
import { fromJson, getDb, nowIso, toJson } from '../client';

export type RunStatus = 'running' | 'completed' | 'failed';

export interface RunRecord {
  id: number;
  mode: DiscoveryMode;
  topic: string | null;
  channelIds: string[];
  engine: ScoringEngineName;
  episodeThreshold: number;
  clipThreshold: number;
  episodesDiscovered: number;
  episodesAnalysed: number;
  episodesSkipped: number;
  clipsFound: number;
  warnings: string[];
  status: RunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

interface RunRow {
  id: number;
  mode: string;
  topic: string | null;
  channel_ids: string;
  engine: string;
  episode_threshold: number;
  clip_threshold: number;
  episodes_discovered: number;
  episodes_analysed: number;
  episodes_skipped: number;
  clips_found: number;
  warnings: string;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    mode: row.mode as DiscoveryMode,
    topic: row.topic,
    channelIds: fromJson<string[]>(row.channel_ids, []),
    engine: row.engine as ScoringEngineName,
    episodeThreshold: row.episode_threshold,
    clipThreshold: row.clip_threshold,
    episodesDiscovered: row.episodes_discovered,
    episodesAnalysed: row.episodes_analysed,
    episodesSkipped: row.episodes_skipped,
    clipsFound: row.clips_found,
    warnings: fromJson<string[]>(row.warnings, []),
    status: row.status as RunStatus,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  };
}

export function createRun(params: {
  mode: DiscoveryMode;
  topic: string | null;
  channelIds: string[];
  engine: ScoringEngineName;
  episodeThreshold: number;
  clipThreshold: number;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO runs (
         mode, topic, channel_ids, engine, episode_threshold, clip_threshold,
         status, started_at
       ) VALUES (
         @mode, @topic, @channelIds, @engine, @episodeThreshold, @clipThreshold,
         'running', @startedAt
       )`,
    )
    .run({
      mode: params.mode,
      topic: params.topic,
      channelIds: toJson(params.channelIds),
      engine: params.engine,
      episodeThreshold: params.episodeThreshold,
      clipThreshold: params.clipThreshold,
      startedAt: nowIso(),
    });

  return Number(result.lastInsertRowid);
}

export function completeRun(params: {
  runId: number;
  episodesDiscovered: number;
  episodesAnalysed: number;
  episodesSkipped: number;
  clipsFound: number;
  warnings: string[];
  durationMs: number;
}): void {
  getDb()
    .prepare(
      `UPDATE runs SET
         episodes_discovered = @episodesDiscovered,
         episodes_analysed   = @episodesAnalysed,
         episodes_skipped    = @episodesSkipped,
         clips_found         = @clipsFound,
         warnings            = @warnings,
         status              = 'completed',
         finished_at         = @finishedAt,
         duration_ms         = @durationMs
       WHERE id = @runId`,
    )
    .run({
      runId: params.runId,
      episodesDiscovered: params.episodesDiscovered,
      episodesAnalysed: params.episodesAnalysed,
      episodesSkipped: params.episodesSkipped,
      clipsFound: params.clipsFound,
      warnings: toJson(params.warnings),
      finishedAt: nowIso(),
      durationMs: params.durationMs,
    });
}

export function failRun(runId: number, error: string, durationMs: number): void {
  getDb()
    .prepare(
      `UPDATE runs SET status = 'failed', error = ?, finished_at = ?, duration_ms = ?
       WHERE id = ?`,
    )
    .run(error, nowIso(), durationMs, runId);
}

export function getRun(runId: number): RunRecord | null {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
  return row ? mapRun(row) : null;
}

export function listRuns(limit = 20): RunRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
    .all(limit) as RunRow[];
  return rows.map(mapRun);
}
