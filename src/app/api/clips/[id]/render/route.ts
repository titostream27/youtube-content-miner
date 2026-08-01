import { config } from '@/lib/config';
import { getClip, updateClipRender } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { badRequest, notFound, ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Select the transcript cues that overlap the clip's [start, end] window,
 * clamped to it, in ABSOLUTE video coordinates. The render service offsets
 * them to the clip and burns them as captions.
 *
 * Cues that STARTED before the clip window are dropped entirely: their first
 * words were spoken before the clip, so they'd appear as dangling fragments
 * ("going on." without "understand what's"). Without word-level timing we
 * can't cleanly split a cue, so the first caption starts from the first cue
 * that begins inside the clip.
 */
function clipCaptions(videoId: string, startSec: number, endSec: number) {
  const transcript = getTranscript(videoId);
  if (!transcript) return [];

  return transcript.cues
    .filter((cue) => cue.startSec >= startSec && cue.startSec < endSec)
    .map((cue) => ({
      start_sec: Math.max(cue.startSec, startSec),
      end_sec: Math.min(cue.endSec, endSec),
      text: cue.text,
    }));
}

/**
 * POST /api/clips/:id/render
 *
 * Hybrid render integration: hand the clip's [start, end] window to the
 * external shorts render service, which downloads the source video once and
 * cuts a vertical (9:16) short. No scoring happens here — the miner already
 * ranked this clip; the render service only produces the file.
 *
 * Response body mirrors the render service:
 *   { jobId, sourceVideo, rendered: [{ clipId, status, durationSec, clipPath?, error? }] }
 */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);

  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  try {
    const clip = getClip(clipId);
    if (!clip) return notFound('Clip not found');

    // Guard: a render is already in flight for this clip. Prevents the UI
    // double-clicking and creating duplicate render jobs for the same video.
    if (clip.renderStatus === 'rendering') {
      return badRequest('Clip render already in progress');
    }

    // Mark as rendering before the long call so a concurrent GET sees intent.
    updateClipRender(clipId, { status: 'rendering' });

    const renderBase = config.render.baseUrl.replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.render.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${renderBase}/api/render`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.render.token ? { 'x-render-token': config.render.token } : {}),
        },
        body: JSON.stringify({
          video_url: `https://www.youtube.com/watch?v=${clip.videoId}`,
          aspect_ratio: '9:16',
          clips: [
            {
              clip_id: clip.id,
              title: clip.title,
              start_sec: clip.startSec,
              end_sec: clip.endSec,
              captions: clipCaptions(clip.videoId, clip.startSec, clip.endSec),
            },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      updateClipRender(clipId, {
        status: 'error',
        error: `render service ${response.status}: ${body.slice(0, 300)}`,
      });
      return badRequest('Render service failed', { status: response.status, detail: body.slice(0, 300) });
    }

    const result = (await response.json()) as {
      job_id?: string;
      source_video?: string;
      rendered?: {
        clip_id: number | string;
        status: string;
        clip_path?: string;
        clip_url?: string;
        error?: string;
      }[];
    };

    const mine = result.rendered?.find((r) => Number(r.clip_id) === clip.id);
    const done = mine?.status === 'ok' && mine.clip_url;

    // Store the render-relative URL (<job>/<file>); the UI builds the public
    // link from config.render.publicBaseUrl so it works from any browser.
    updateClipRender(clipId, {
      status: done ? 'done' : 'error',
      jobId: result.job_id ?? null,
      path: done ? mine.clip_url : null,
      error: done ? null : (mine?.error ?? 'render service returned no clip'),
    });

    const publicBase = config.render.publicBaseUrl.replace(/\/$/, '');
    const refreshed = getClip(clipId);
    return ok({
      jobId: result.job_id ?? null,
      sourceVideo: result.source_video ?? null,
      clip: refreshed,
      publicUrl:
        refreshed?.renderStatus === 'done' && refreshed.renderPath
          ? `${publicBase}/files/${refreshed.renderPath}`
          : null,
    });
  } catch (error) {
    // Fetch aborted by timeout — surface it as a render error, not a 500.
    if (error instanceof Error && error.name === 'AbortError') {
      updateClipRender(clipId, {
        status: 'error',
        error: `render timed out after ${config.render.timeoutMs}ms`,
      });
      return badRequest('Render timed out', { timeoutMs: config.render.timeoutMs });
    }
    return serverError(error);
  }
}
