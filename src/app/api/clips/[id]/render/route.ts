import { config } from '@/lib/config';
import { getClip, updateClipRender } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { generateClipHook } from '@/lib/ai/agents/clip-hook-agent';
import { upsertRenderJob } from '@/lib/db/repositories/render-jobs';
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
 * Plain text of the transcript cues that fall inside the clip window. Used to
 * generate the hook line (Phase 5) — the hook needs the actual spoken content,
 * not the SEO title.
 */
function clipTranscript(videoId: string, startSec: number, endSec: number): string {
  const transcript = getTranscript(videoId);
  if (!transcript) return '';

  return transcript.cues
    .filter((cue) => cue.startSec >= startSec && cue.startSec < endSec)
    .map((cue) => cue.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * POST /api/clips/:id/render
 *
 * Hybrid render integration (Phase 2, brief §18-19): queue an ASYNC final
 * render on the render service and return immediately. The caller polls
 * GET /api/render-jobs/:id or /api/episodes/:videoId/render-status.
 *
 * (Was a blocking synchronous call to /api/render that timed out on long
 * clips and left the clip stuck in "rendering".)
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

    // Phase 5: generate the spoken hook from the clip transcript. Optional —
    // if the agent fails we still render without an intro.
    let hook = '';
    try {
      const transcriptText = clipTranscript(clip.videoId, clip.startSec, clip.endSec);
      if (transcriptText.length > 20) {
        const hookResult = await generateClipHook({
          transcript: transcriptText,
          episodeTitle: clip.episodeTitle ?? clip.title,
          clipTitle: clip.title,
        });
        hook = hookResult.hook;
        console.log(`[render] clip ${clipId} hook: "${hook}"`);
      }
    } catch (e) {
      console.warn(`[render] clip ${clipId} hook generation failed: ${e}`);
    }

    const renderBase = config.render.baseUrl.replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.render.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${renderBase}/api/render/async`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.render.token ? { 'x-render-token': config.render.token } : {}),
        },
        body: JSON.stringify({
          contract_version: '2.0',
          request_id: `render:${clip.videoId}:${clipId}:final`,
          episode_id: clip.videoId,
          video_url: `https://www.youtube.com/watch?v=${clip.videoId}`,
          mode: 'final',
          clips: [
            {
              clip_id: clip.id,
              start_sec: clip.startSec,
              end_sec: clip.endSec,
              narrative: { main_topic: clip.mainTopic ?? '' },
              caption_plan: {
                language: 'en',
                cues: clipCaptions(clip.videoId, clip.startSec, clip.endSec).map((c) => ({
                  start_sec: c.start_sec,
                  end_sec: c.end_sec,
                  text: c.text,
                })),
              },
              hook,
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
    };
    const jobId = result.job_id ?? null;

    // Persist job + link it to the clip so render-status polling finds it.
    if (jobId) {
      upsertRenderJob({
        jobId,
        episodeId: clip.videoId,
        mode: 'final',
        status: 'running',
      });
      updateClipRender(clipId, { status: 'rendering', jobId });
    }

    return ok({
      jobId,
      mode: 'final',
      message: 'Final render queued. Poll GET /api/render-jobs/:id or /api/episodes/:videoId/render-status',
    });
  } catch (error) {
    // Fetch aborted by timeout — surface it as a render error, not a 500.
    if (error instanceof Error && error.name === 'AbortError') {
      updateClipRender(clipId, {
        status: 'error',
        error: `render queue timed out after ${config.render.timeoutMs}ms`,
      });
      return badRequest('Render queue timed out', { timeoutMs: config.render.timeoutMs });
    }
    return serverError(error);
  }
}
