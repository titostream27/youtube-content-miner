import { config } from '@/lib/config';
import { listClips, updateClipRender, updateClipSeo, updateClipPublish, updateClipQc } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { getEpisode } from '@/lib/db/repositories/episodes';
import { generateClipSeo } from '@/lib/ai/agents/clip-seo-agent';
import type { ClipRecord } from '@/lib/db/repositories/clips';
import { buildRenderContract } from '@/lib/render/contract';
import { sendTelegram } from '@/lib/notify/telegram';

/**
 * Auto-process pipeline: after a discovery run finishes, every clip that
 * cleared the threshold (non-archive tier) from the analysed episodes is
 * automatically pushed through render → SEO → publish.
 *
 * This runs as a fire-and-forget background job from POST /api/runs when the
 * caller opts in (`autoProcess: true`). Each step is persisted to the DB so
 * the UI reflects progress, and failures are recorded per clip instead of
 * aborting the whole batch.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Render all clips of one episode via the render service (async batch). */
async function renderEpisodeAll(
  videoId: string,
  clips: ClipRecord[],
  mode: 'preview' | 'final' = 'final',
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  // Generate hooks (DeepSeek) per clip — same as the render-all route.
  const episode = getEpisode(videoId);

  // Phase 2 (brief §16-18): build the versioned v2 contract once for the
  // whole episode so the renderer downloads the source a single time.
  const clipWithHooks: (ClipRecord & { hook: string })[] = [];
  for (const c of clips) {
    let hook = '';
    try {
      const transcriptText = clipTranscript(videoId, c.startSec, c.endSec);
      if (transcriptText.length > 20) {
        const hookResult = await generateClipHookSafe(transcriptText, episode?.title ?? c.title, c.title);
        hook = hookResult;
      }
    } catch (e) {
      console.warn(`[auto-process] hook failed for clip ${c.id}: ${e}`);
    }
    clipWithHooks.push({ ...c, hook });
  }

  const transcript = getTranscript(videoId);
  const contract = buildRenderContract(videoId, clipWithHooks, {
    mode,
    mainTopic: clips[0]?.mainTopic ?? null,
    endingType: clips[0]?.endingType ?? null,
    // Phase 2 (Canonical transcript): propagate the real language + cues.
    language: transcript?.language || 'en',
    transcript,
  });
  // Attach hooks + canonical transcript cues (with speaker identity) into the
  // contract clips (buildRenderContract doesn't know about hooks — legacy v1
  // passthrough).
  const payload = {
    ...contract,
    clips: contract.clips.map((cc, i) => {
      const clip = clipWithHooks[i]!;
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
  try {
    const response = await fetch(`${renderBase}/api/render/async`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.render.token ? { 'x-render-token': config.render.token } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, error: `render service ${response.status}: ${body.slice(0, 300)}` };
    }
    const result = (await response.json()) as { job_id?: string };
    const jobId = result.job_id ?? undefined;

    // Persist the job id on each clip so pollRenderUntilDone can poll it.
    if (jobId) {
      for (const c of clips) {
        updateClipRender(c.id, { status: 'rendering', jobId });
      }
    }

    return { ok: true, jobId };
  } catch (e) {
    return { ok: false, error: `render service unreachable: ${e}` };
  }
}

/** Poll the render service until the async batch job finishes. */
async function notifyBatchDone(
  videoId: string,
  clips: ClipRecord[],
  doneCount: number,
): Promise<void> {
  // Best-effort: Telegram failure must never break the pipeline.
  try {
    const episode = getEpisode(videoId);
    const top = clips[0];
    const title = top?.episodeTitle ?? episode?.title ?? videoId;
    await sendTelegram({
      text: [
        `🎞️ *Render selesai: ${title}*`,
        `✅ ${doneCount}/${clips.length} clip siap review`,
        ...clips.slice(0, 3).map((c) => `• ${c.title} (${c.durationSec.toFixed(0)}s, 💯${c.finalScore})`),
      ].join('\n'),
      parseMode: 'Markdown',
    });
  } catch {
    // ignore
  }
}

async function pollRenderUntilDone(
  videoId: string,
  clips: ClipRecord[],
  jobId: string,
  maxWaitMs = 60 * 60 * 1000,
): Promise<void> {
  const renderBase = config.render.baseUrl.replace(/\/$/, '');
  const startedAt = Date.now();

  if (!jobId) {
    // No job id means the render was never accepted — fail the clips rather
    // than spinning for an hour waiting for an id that will never arrive.
    for (const c of clips) {
      updateClipRender(c.id, { status: 'error', error: 'render service returned no job id' });
    }
    return;
  }

  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const response = await fetch(`${renderBase}/api/render/status/${jobId}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await sleep(10_000);
        continue;
      }
      const body = (await response.json()) as {
        state: string;
        error?: string | null;
        rendered?: {
          clip_id: number | string;
          status: string;
          clip_url?: string;
          error?: string;
          quality?: { status?: string; score?: number };
        }[];
      };

      if (body.state === 'done' && body.rendered) {
        for (const item of body.rendered) {
          const clipId = Number(item.clip_id);
          const done = item.status === 'ok' && item.clip_url;
          updateClipRender(clipId, {
            status: done ? 'done' : 'error',
            jobId,
            path: done ? item.clip_url : null,
            error: done ? null : (item.error ?? 'render service returned no clip'),
          });
          // Phase 2 (brief §23-24): persist QC result so the publish gate
          // can enforce QC pass.
          if (item.quality?.status) {
            updateClipQc(clipId, {
              status: item.quality.status === 'pass' ? 'passed' : item.quality.status,
              score: item.quality.score ?? null,
              note: JSON.stringify(item.quality),
            });
          }
        }
        // Phase 2 (Automation): notify the operator when the batch finished.
        const doneCount = body.rendered.filter((r) => r.status === 'ok' && r.clip_url).length;
        await notifyBatchDone(videoId, clips, doneCount);
        return;
      }

      if (body.state === 'error') {
        for (const c of clips) {
          updateClipRender(c.id, { status: 'error', error: body.error ?? 'render job failed' });
        }
        return;
      }
    } catch {
      // Transient status fetch failure — keep polling.
    }

    await sleep(15_000);
  }

  for (const c of clips) {
    if (c.renderStatus === 'rendering') {
      updateClipRender(c.id, { status: 'error', error: 'auto-process render timed out' });
    }
  }
}

/** Generate SEO metadata for one clip (DeepSeek agent), persist to DB. */
async function seoClip(clip: ClipRecord): Promise<boolean> {
  let transcript = clip.transcript.trim();
  if (!transcript) {
    const full = getTranscript(clip.videoId);
    transcript = (full?.cues ?? [])
      .filter((cue) => cue.startSec >= clip.startSec && cue.startSec < clip.endSec)
      .map((cue) => cue.text)
      .join(' ')
      .trim();
  }
  if (!transcript) return false;

  try {
    const seo = await generateClipSeo({
      transcript,
      episodeTitle: clip.episodeTitle,
      durationSec: clip.durationSec,
    });
    updateClipSeo(clip.id, {
      title: seo.titles[0] ?? clip.title,
      description: seo.description,
      tags: seo.tags,
    });
    return true;
  } catch (e) {
    console.error(`[auto-process] seo failed for clip ${clip.id}: ${e}`);
    return false;
  }
}

/** Publish one rendered + SEO'd clip via the poster service. */
async function publishClip(clip: ClipRecord): Promise<void> {
  const publishBase = config.publish.baseUrl.replace(/\/$/, '');
  const renderBase = config.render.baseUrl.replace(/\/$/, '');
  const jobId = clip.renderPath?.split('/')[0] ?? '';
  const fileUrl = `${renderBase}/files/${clip.renderPath}`;
  const thumbnailUrl = jobId ? `${renderBase}/files/${jobId}/thumbnail.jpg` : '';

  try {
    const response = await fetch(`${publishBase}/api/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.publish.token ? { 'x-poster-token': config.publish.token } : {}),
      },
      body: JSON.stringify({
        clip_id: clip.id,
        title: clip.seoTitle ?? clip.title,
        description: clip.seoDescription ?? '',
        tags: clip.seoTags,
        file_url: fileUrl,
        thumbnail_url: thumbnailUrl,
        privacy: config.publish.privacy,
      }),
      signal: AbortSignal.timeout(config.publish.timeoutMs),
    });

    const body = (await response.json().catch(() => null)) as
      | { detail?: string; url?: string; status?: string; videoId?: string }
      | null;

    if (!response.ok) {
      const msg = body?.detail ?? `Publish failed with ${response.status}`;
      updateClipPublish(clip.id, { status: 'error', error: msg });
      console.error(`[auto-process] publish failed clip ${clip.id}: ${msg}`);
      return;
    }

    updateClipPublish(clip.id, {
      status: 'published',
      url: body?.url ?? null,
      error: null,
    });
    console.log(`[auto-process] clip ${clip.id} published: ${body?.url ?? ''}`);
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError'
      ? 'Publish timed out'
      : `Poster service unreachable: ${e}`;
    updateClipPublish(clip.id, { status: 'error', error: msg });
    console.error(`[auto-process] publish failed clip ${clip.id}: ${msg}`);
  }
}

/**
 * Entry point: auto-process every non-archive clip produced by a run.
 * Groups clips by episode, renders each episode as one batch, then SEO +
 * publish per clip. Never throws — failures are recorded on the clip.
 */
export async function autoProcessRun(runId: number): Promise<void> {
  console.log(`[auto-process] starting for run ${runId}`);

  const clips = listClips({ runId });
  // Only clips that cleared the threshold — archive is a training bucket.
  const candidates = clips.filter((c) => c.tier !== 'archive');
  console.log(`[auto-process] run ${runId}: ${candidates.length}/${clips.length} clips to process`);

  if (candidates.length === 0) {
    console.log(`[auto-process] run ${runId}: nothing to process`);
    return;
  }

  // Group by episode so each episode is one render batch (single source download).
  const byEpisode = new Map<string, ClipRecord[]>();
  for (const c of candidates) {
    const list = byEpisode.get(c.videoId) ?? [];
    list.push(c);
    byEpisode.set(c.videoId, list);
  }

  for (const [videoId, episodeClips] of byEpisode) {
    // Skip clips that are already rendered (e.g. a previous auto-process pass
    // finished them before a crash/restart).
    const pending = episodeClips.filter((c) => c.renderStatus !== 'done');
    if (pending.length === 0) {
      console.log(`[auto-process] episode ${videoId}: all clips already rendered, skipping render`);
    } else {
      console.log(`[auto-process] episode ${videoId}: rendering ${pending.length} clips`);

      // Mark rendering before the long call so the UI sees intent.
      for (const c of pending) {
        updateClipRender(c.id, { status: 'rendering' });
      }

      const render = await renderEpisodeAll(videoId, pending);
      if (!render.ok) {
        for (const c of pending) {
          updateClipRender(c.id, { status: 'error', error: render.error ?? 'render failed' });
        }
        console.error(`[auto-process] render batch failed for ${videoId}: ${render.error}`);
        continue;
      }

      // Wait for the batch job to finish (up to 60 min).
      await pollRenderUntilDone(videoId, pending, render.jobId ?? '');
    }

    // SEO for every successfully rendered clip.
    for (const c of episodeClips) {
      const refreshed = listClips({ videoId, limit: 500 }).find((x) => x.id === c.id) ?? c;
      if (refreshed.renderStatus === 'done' && !refreshed.seoTitle) {
        console.log(`[auto-process] clip ${c.id}: generating SEO`);
        await seoClip(refreshed);
      }
    }

    // Publish every rendered + SEO'd clip.
    for (const c of episodeClips) {
      const refreshed = listClips({ videoId, limit: 500 }).find((x) => x.id === c.id) ?? c;
      if (
        refreshed.renderStatus === 'done' &&
        refreshed.seoTitle &&
        refreshed.publishStatus !== 'published'
      ) {
        console.log(`[auto-process] clip ${c.id}: publishing`);
        await publishClip(refreshed);
      }
    }
  }

  console.log(`[auto-process] run ${runId} finished`);
}

/**
 * Hook generation helper (imported lazily to avoid a circular import with the
 * clip-hook agent at module load time).
 */
async function generateClipHookSafe(
  transcript: string,
  episodeTitle: string,
  clipTitle: string,
): Promise<string> {
  const { generateClipHook } = await import('@/lib/ai/agents/clip-hook-agent');
  const result = await generateClipHook({ transcript, episodeTitle, clipTitle });
  return result.hook;
}
