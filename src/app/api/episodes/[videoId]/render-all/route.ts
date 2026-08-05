import { config } from '@/lib/config';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { getEpisode } from '@/lib/db/repositories/episodes';
import { listClips, updateClipRender } from '@/lib/db/repositories/clips';
import { generateClipHook } from '@/lib/ai/agents/clip-hook-agent';
import { upsertRenderJob } from '@/lib/db/repositories/render-jobs';
import { buildRenderContract } from '@/lib/render/contract';
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

/**
 * POST /api/episodes/:videoId/render-all
 *
 * Phase 2 (Master Task Brief §18) — episode batch rendering: render ALL clips
 * of an episode in ONE render service call using the versioned v2 contract
 * (the source video is downloaded once and each clip is cut from it).
 *
 * Query params:
 *   ?force=1       re-render clips already done
 *   ?mode=preview  render a cheap preview (540x960) instead of final
 *
 * Already-done clips are skipped unless `force=1` is passed.
 */
export async function POST(request: Request, context: RouteContext) {
  const { videoId } = await context.params;
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const mode = url.searchParams.get('mode') === 'preview' ? 'preview' : 'final';

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

  // Generate hooks (DeepSeek) for clips.
  const clipWithHooks: (typeof pending[number] & { hook: string })[] = [];
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
    clipWithHooks.push({ ...c, hook });
  }

  // Phase 2 (brief §16): build the versioned v2 contract.
  const transcript = getTranscript(videoId);
  const contract = buildRenderContract(videoId, clipWithHooks, {
    mode,
    mainTopic: pending[0]?.mainTopic ?? null,
    endingType: pending[0]?.endingType ?? null,
    // Phase 2 (Canonical transcript): propagate the real language.
    language: transcript?.language || 'en',
  });
  const payload = {
    ...contract,
    clips: contract.clips.map((cc, i) => {
      const clip = clipWithHooks[i]!;
      // Phase 2 (Canonical transcript): prefer real transcript cues with
      // speaker identity over the flat suggested-caption hint.
      const realCues = (transcript?.cues ?? [])
        .filter((cue) => cue.startSec >= clip.startSec && cue.startSec < clip.endSec)
        .map((cue) => ({
          start_sec: Math.max(cue.startSec, clip.startSec),
          end_sec: Math.min(cue.endSec, clip.endSec),
          text: cue.text,
          ...(cue.speakerId ? { speaker_id: cue.speakerId } : {}),
        }));
      return {
        ...cc,
        hook: clip.hook ?? '',
        caption_plan: {
          ...cc.caption_plan,
          cues: realCues.length > 0 ? realCues : cc.caption_plan.cues,
        },
      };
    }),
  };

  const renderBase = config.render.baseUrl.replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${renderBase}/api/render/async`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.render.token ? { 'x-render-token': config.render.token } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    for (const c of pending) {
      updateClipRender(c.id, { status: 'error', error: `render service unreachable: ${e}` });
    }
    return serverError(e);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    for (const c of pending) {
      updateClipRender(c.id, { status: 'error', error: `render service ${response.status}` });
    }
    return badRequest('Render service failed', { status: response.status, detail: body.slice(0, 300) });
  }

  const result = (await response.json()) as { job_id?: string };
  const jobId = result.job_id ?? null;

  // Phase 2 (brief §19): persist the job so restart does not lose it.
  if (jobId) {
    try {
      upsertRenderJob({
        jobId,
        episodeId: videoId,
        mode,
        status: 'queued',
        request: JSON.stringify(payload),
      });
    } catch (e) {
      console.warn(`[render-all] job persist failed: ${e}`);
    }
  }

  // Async: the job runs in the background. Store the job id on each pending
  // clip; a separate poll endpoint (render-status) updates clips when done.
  for (const c of pending) {
    updateClipRender(c.id, {
      status: 'rendering',
      jobId,
    });
  }

  return ok({
    jobId,
    mode,
    queued: pending.length,
    skipped: clips.length - pending.length,
    message: `Queued ${pending.length} clip(s) for ${mode} rendering`,
  });
}
