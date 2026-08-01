import { config } from '@/lib/config';
import { listClips, updateClipRender } from '@/lib/db/repositories/clips';
import { ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

/**
 * GET /api/episodes/:videoId/render-status
 *
 * Phase 8 — poll endpoint for async batch renders. Reads the job_id stored on
 * the episode's clips, asks the render service for job state, and writes the
 * per-clip results back to the DB. Returns a summary for the UI.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { videoId } = await context.params;
  const clips = listClips({ videoId });

  const rendering = clips.filter((c) => c.renderStatus === 'rendering');
  if (rendering.length === 0) {
    const done = clips.filter((c) => c.renderStatus === 'done').length;
    return ok({ state: 'idle', done, total: clips.length });
  }

  const jobId = rendering[0]?.renderJobId;
  if (!jobId) {
    return ok({ state: 'running', message: 'job id not set yet' });
  }

  const renderBase = config.render.baseUrl.replace(/\/$/, '');
  try {
    const response = await fetch(`${renderBase}/api/render/status/${jobId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // Job gone (service restarted?) — leave clips in rendering; the UI will
      // show them as in-progress until the user re-runs.
      return ok({ state: 'running', jobId });
    }
    const body = (await response.json()) as {
      state: string;
      error?: string | null;
      rendered?: { clip_id: number | string; status: string; clip_url?: string; error?: string }[];
    };

    if (body.state === 'done' && body.rendered) {
      let doneCount = 0;
      let failedCount = 0;
      for (const item of body.rendered) {
        const clipId = Number(item.clip_id);
        const done = item.status === 'ok' && item.clip_url;
        updateClipRender(clipId, {
          status: done ? 'done' : 'error',
          jobId,
          path: done ? item.clip_url : null,
          error: done ? null : (item.error ?? 'render service returned no clip'),
        });
        if (done) doneCount += 1;
        else failedCount += 1;
      }
      return ok({ state: 'done', jobId, rendered: doneCount, failed: failedCount });
    }

    if (body.state === 'error') {
      for (const c of rendering) {
        updateClipRender(c.id, { status: 'error', error: body.error ?? 'render job failed' });
      }
      return ok({ state: 'error', jobId, error: body.error });
    }

    return ok({ state: 'running', jobId });
  } catch (e) {
    return ok({ state: 'running', jobId, note: `status fetch failed: ${e}` });
  }
}
