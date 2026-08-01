import { config } from '@/lib/config';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { getEpisode } from '@/lib/db/repositories/episodes';
import { listClips, updateClipRender } from '@/lib/db/repositories/clips';
import { generateClipHook } from '@/lib/ai/agents/clip-hook-agent';
import { badRequest, notFound, ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

/** Plain transcript text for a clip window (for hook generation). */
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

/** ASR cues inside the clip window (for caption burning). */
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
 * POST /api/episodes/:videoId/render-all
 *
 * Phase 8 — batch pipeline: render EVERY clip of an episode in one render
 * service call (the source video is downloaded once and each clip is cut
 * from it). Hooks are generated per clip first. Already-done clips are
 * skipped unless `?force=1` is passed.
 */
export async function POST(request: Request, context: RouteContext) {
  const { videoId } = await context.params;
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  const episode = getEpisode(videoId);
  if (!episode) return notFound('Episode not found');

  const clips = listClips({ videoId });
  if (clips.length === 0) return badRequest('Episode has no clips yet');

  const pending = force ? clips : clips.filter((c) => c.renderStatus !== 'done');
  if (pending.length === 0) {
    return ok({ message: 'All clips already rendered', rendered: [], skipped: clips.length });
  }

  // Mark every pending clip as rendering so concurrent GETs see intent.
  for (const c of pending) {
    updateClipRender(c.id, { status: 'rendering' });
  }

  // Generate hooks (DeepSeek) for clips that don't have SEO text as fallback.
  const clipPayloads = [];
  for (const c of pending) {
    let hook = '';
    try {
      const transcriptText = clipTranscript(videoId, c.startSec, c.endSec);
      if (transcriptText.length > 20) {
        const hookResult = await generateClipHook({
          transcript: transcriptText,
          episodeTitle: episode.title ?? c.title,
          clipTitle: c.title,
        });
        hook = hookResult.hook;
      }
    } catch (e) {
      console.warn(`[render-all] hook failed for clip ${c.id}: ${e}`);
    }
    clipPayloads.push({
      clip_id: c.id,
      title: c.title,
      start_sec: c.startSec,
      end_sec: c.endSec,
      captions: clipCaptions(videoId, c.startSec, c.endSec),
      hook,
    });
  }

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
        video_url: `https://www.youtube.com/watch?v=${videoId}`,
        aspect_ratio: '9:16',
        clips: clipPayloads,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Reset pending clips to error so the UI doesn't hang in "rendering".
    for (const c of pending) {
      updateClipRender(c.id, { status: 'error', error: `render service ${response.status}` });
    }
    return badRequest('Render service failed', { status: response.status, detail: body.slice(0, 300) });
  }

  const result = (await response.json()) as {
    job_id?: string;
    rendered?: {
      clip_id: number | string;
      status: string;
      clip_url?: string;
      error?: string;
    }[];
  };

  // Store results back per clip.
  let renderedCount = 0;
  let failedCount = 0;
  for (const item of result.rendered ?? []) {
    const clipId = Number(item.clip_id);
    const done = item.status === 'ok' && item.clip_url;
    const exists = pending.some((p) => p.id === clipId);
    if (!exists) continue;
    updateClipRender(clipId, {
      status: done ? 'done' : 'error',
      jobId: result.job_id ?? null,
      path: done ? item.clip_url : null,
      error: done ? null : (item.error ?? 'render service returned no clip'),
    });
    if (done) renderedCount += 1;
    else failedCount += 1;
  }

  return ok({
    jobId: result.job_id ?? null,
    total: pending.length,
    rendered: renderedCount,
    failed: failedCount,
    skipped: clips.length - pending.length,
  });
}
