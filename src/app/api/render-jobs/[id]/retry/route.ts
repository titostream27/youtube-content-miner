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
 * POST /api/render-jobs/:id/retry
 *
 * Phase 2 (brief §19/§39) — re-queue a failed/partial job using the original
 * request stored at creation time. Delegates to the renderer's retry endpoint
 * which returns a NEW job id (history is preserved).
 */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const local = getRenderJob(id);
  if (!local) return notFound('Render job not found');

  const renderBase = config.render.baseUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${renderBase}/api/render/jobs/${id}/retry`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return ok({ jobId: id, error: `renderer retry failed ${res.status}: ${body.slice(0, 200)}` });
    }
    const body = (await res.json()) as { job_id?: string; state?: string };
    if (body.job_id) {
      upsertRenderJob({
        jobId: body.job_id,
        episodeId: local.episodeId,
        mode: local.mode,
        status: 'queued',
        error: null,
      });
    }
    return ok({ jobId: body.job_id ?? id, originalJobId: id, state: body.state ?? 'queued' });
  } catch (e) {
    return ok({ jobId: id, error: `render service unreachable: ${e}` });
  }
}
