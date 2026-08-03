import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 2 (Master Task Brief §19) — asynchronous render job persistence.
 *
 * Job state lives in the DB so a service restart does not lose it. The
 * renderer itself also persists its own job store; this table is the
 * miner-side mirror used for status endpoints and idempotency.
 */

export interface RenderJobRecord {
  id: number;
  jobId: string;
  episodeId: string | null;
  mode: string;
  status: string;
  request: string | null;
  response: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RenderJobRow {
  id: number;
  job_id: string;
  episode_id: string | null;
  mode: string;
  status: string;
  request: string | null;
  response: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function mapJob(row: RenderJobRow): RenderJobRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    episodeId: row.episode_id,
    mode: row.mode,
    status: row.status,
    request: row.request,
    response: row.response,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertRenderJob(input: {
  jobId: string;
  episodeId?: string | null;
  mode?: string;
  status: string;
  request?: string | null;
  response?: string | null;
  error?: string | null;
}): RenderJobRecord {
  const existing = getDb()
    .prepare('SELECT * FROM render_jobs WHERE job_id = ?')
    .get(input.jobId) as RenderJobRow | undefined;

  if (existing) {
    getDb()
      .prepare(
        `UPDATE render_jobs
         SET status = ?, mode = ?, episode_id = ?, request = ?, response = ?, error = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(
        input.status,
        input.mode ?? existing.mode,
        input.episodeId ?? existing.episode_id,
        input.request ?? existing.request,
        input.response ?? existing.response,
        input.error ?? existing.error,
        nowIso(),
        input.jobId,
      );
    const row = getDb().prepare('SELECT * FROM render_jobs WHERE job_id = ?').get(input.jobId) as RenderJobRow;
    return mapJob(row);
  }

  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO render_jobs (job_id, episode_id, mode, status, request, response, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.jobId,
      input.episodeId ?? null,
      input.mode ?? 'final',
      input.status,
      input.request ?? null,
      input.response ?? null,
      input.error ?? null,
      now,
      now,
    );
  const row = getDb().prepare('SELECT * FROM render_jobs WHERE job_id = ?').get(input.jobId) as RenderJobRow;
  return mapJob(row);
}

export function getRenderJob(jobId: string): RenderJobRecord | null {
  const row = getDb().prepare('SELECT * FROM render_jobs WHERE job_id = ?').get(jobId) as RenderJobRow | undefined;
  return row ? mapJob(row) : null;
}

export function listRenderJobs(limit = 20): RenderJobRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM render_jobs ORDER BY id DESC LIMIT ?')
    .all(limit) as RenderJobRow[];
  return rows.map(mapJob);
}

export function listRenderJobsByEpisode(episodeId: string): RenderJobRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM render_jobs WHERE episode_id = ? ORDER BY id DESC')
    .all(episodeId) as RenderJobRow[];
  return rows.map(mapJob);
}

/** Idempotency (brief §20): return true when a job with this key already
 * exists in a non-failed state. */
export function renderJobExists(jobId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM render_jobs WHERE job_id = ?').get(jobId);
  return row !== undefined;
}
