import { ok, notFound, serverError } from '@/lib/api/http';
import { getRun } from '@/lib/db/repositories/runs';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/runs/:id/process
 *
 * Fire-and-forget re-trigger of the auto-process pipeline for a finished run:
 * every non-archive clip from the analysed episodes is pushed through
 * render → SEO → publish. Idempotent-ish: clips that are already rendered /
 * SEO'd / published are skipped by the auto-process pipeline itself.
 *
 * Response returns immediately; progress is visible in the UI via the
 * per-clip render/SEO/publish status fields.
 */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const runId = Number.parseInt(id, 10);

  if (!Number.isFinite(runId)) {
    return notFound('Run id must be numeric');
  }

  try {
    const run = getRun(runId);
    if (!run) return notFound('Run not found');

    const { autoProcessRun } = await import('@/lib/pipeline/auto-process');
    void autoProcessRun(runId).catch((err) => {
      console.error(`[api] auto-process failed for run ${runId}:`, err);
    });

    return ok({ triggered: true, runId });
  } catch (err) {
    console.error(`[api] failed to trigger auto-process for run ${runId}`, err);
    return serverError('Failed to trigger auto-process');
  }
}
