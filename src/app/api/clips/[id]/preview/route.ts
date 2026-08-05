import { config } from '@/lib/config';
import { getClip, updateClipRender, updateClipQc } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { buildRenderContract } from '@/lib/render/contract';
import { upsertRenderJob } from '@/lib/db/repositories/render-jobs';
import { probeRenderJob } from '@/lib/render/job-probe';
import { badRequest, notFound, ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/clips/:id/preview
 *
 * Phase 2 (Master Task Brief §21/§39) — draft preview for ONE clip. Renders a
 * cheap 540x960 preview (lower bitrate, faster preset, no full mastering) so
 * a human can review the boundary before the final render.
 *
 * Uses the same v2 contract and the same boundary as the final render.
 */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  try {
    const clip = getClip(clipId);
    if (!clip) return notFound('Clip not found');
    if (clip.renderStatus === 'rendering') {
      // Self-heal: if the render service was restarted mid-job, the stored
      // job id no longer exists and the clip would stay 'rendering' forever,
      // blocking re-renders. Probe the job; if gone, clear stale state.
      const probe = await probeRenderJob(clip.renderJobId);
      if (probe.ok) {
        return badRequest('Clip render already in progress');
      }
      if (probe.gone) {
        updateClipRender(clipId, { status: 'none', jobId: null, error: null });
      } else {
        return badRequest('Clip render already in progress (job open)');
      }
    }

    // Mark as rendering (preview is also a render_status state).
    updateClipRender(clipId, { status: 'rendering' });

    const transcript = getTranscript(clip.videoId);
    const contract = buildRenderContract(clip.videoId, [clip], {
      mode: 'preview',
      mainTopic: clip.mainTopic,
      endingType: clip.endingType,
      // Phase 2 (Canonical transcript): propagate the real language.
      language: transcript?.language || 'en',
    });
    // Legacy hook passthrough is not needed for preview (no intro TTS).

    const renderBase = config.render.baseUrl.replace(/\/$/, '');
    let response: Response;
    try {
      response = await fetch(`${renderBase}/api/render/async`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.render.token ? { 'x-render-token': config.render.token } : {}),
        },
        body: JSON.stringify(contract),
      });
    } catch (e) {
      updateClipRender(clipId, { status: 'error', error: `render service unreachable: ${e}` });
      return serverError(e);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      updateClipRender(clipId, { status: 'error', error: `render service ${response.status}: ${body.slice(0, 300)}` });
      return badRequest('Render service failed', { status: response.status, detail: body.slice(0, 300) });
    }

    const result = (await response.json()) as { job_id?: string };
    const jobId = result.job_id ?? null;

    if (jobId) {
      try {
        upsertRenderJob({ jobId, episodeId: clip.videoId, mode: 'preview', status: 'queued', request: JSON.stringify(contract) });
      } catch (e) {
        console.warn(`[preview] job persist failed: ${e}`);
      }
      updateClipRender(clipId, { status: 'rendering', jobId });
      // Preview is not publishable: QC remains pending until final render.
      updateClipQc(clipId, { status: 'pending', score: null, note: 'preview render queued' });
    }

    return ok({
      jobId,
      mode: 'preview',
      message: 'Preview render queued. Poll GET /api/episodes/:videoId/render-status or /api/render-jobs/:id',
    });
  } catch (error) {
    return serverError(error);
  }
}
