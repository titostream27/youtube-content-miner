import { config } from '@/lib/config';
import {
  getRenderJob,
  upsertRenderJob,
} from '@/lib/db/repositories/render-jobs';
import { notFound, ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/render-jobs/:id
 * Phase 2 (brief §19) — fetch job state. When the job exists locally we
 * return the persisted snapshot; we also probe the render service for the
 * live state and merge it (so a completed job refreshes its response).
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const local = getRenderJob(id);
  if (!local) return notFound('Render job not found');

  const renderBase = config.render.baseUrl.replace(/\/$/, '');
  let live: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${renderBase}/api/render/status/${id}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      live = (await res.json()) as Record<string, unknown>;
      // Mirror the live status back into the DB (idempotent upsert).
      const liveStatus = String(live.state ?? local.status);
      if (liveStatus !== local.status && liveStatus !== 'running') {
        upsertRenderJob({
          jobId: id,
          status: liveStatus,
          response: JSON.stringify(live),
          error: live.error ? String(live.error) : null,
        });
      }
    }
  } catch {
    live = null; // render service down; fall back to local snapshot
  }

  return ok({
    jobId: local.jobId,
    episodeId: local.episodeId,
    mode: local.mode,
    status: live?.state ?? local.status,
    response: live ?? (local.response ? safeParse(local.response) : null),
    error: live?.error ?? local.error,
    createdAt: local.createdAt,
    updatedAt: local.updatedAt,
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
