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
 * POST /api/render-jobs/:id/cancel
 * Phase 2 (brief §19/§39) — cancel a queued render job.
 */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const local = getRenderJob(id);
  if (!local) return notFound('Render job not found');

  const renderBase = config.render.baseUrl.replace(/\/$/, '');
  let cancelled = false;
  try {
    const res = await fetch(`${renderBase}/api/render/jobs/${id}/cancel`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { state?: string };
      cancelled = body.state === 'cancelled';
    }
  } catch {
    // renderer down; still mark locally
  }

  upsertRenderJob({
    jobId: id,
    status: cancelled ? 'cancelled' : 'cancelled_requested',
    error: cancelled ? null : 'cancel requested; render service unreachable',
  });

  return ok({ jobId: id, status: cancelled ? 'cancelled' : 'cancelled_requested' });
}
