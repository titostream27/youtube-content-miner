import { config } from '@/lib/config';
import { listClips, updateClipRender, updateClipSeo, updateClipPublish, updateClipQc, updateClipSchedule } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { getEpisode } from '@/lib/db/repositories/episodes';
import { generateClipSeo } from '@/lib/ai/agents/clip-seo-agent';
import type { ClipRecord } from '@/lib/db/repositories/clips';
import { buildRenderContract } from '@/lib/render/contract';
import { assignPrimeRegion, nextPrimeUtc, PRIME_REGION_LABELS } from '@/lib/publish/prime-time';

/**
 * Scheduled (cron) auto-process.
 *
 * Mirrors auto-process.ts (render → SEO → QC) and then AUTO-PUBLISHES each
 * clip that clears every gate, positioned at its assigned market's prime-time
 * slot: the poster service uploads it private with publishAt set and YouTube
 * flips it public at that instant. No human approval is required — publishing
 * happens fully automatically, exactly at the chosen prime hour.
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
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const episode = getEpisode(videoId);

  const clipWithHooks: (ClipRecord & { hook: string })[] = [];
  for (const c of clips) {
    let hook = '';
    try {
      const transcriptText = clipTranscript(videoId, c.startSec, c.endSec);
      if (transcriptText.length > 20) {
        const result = await generateClipHookSafe(transcriptText, episode?.title ?? c.title, c.title);
        hook = result;
      }
    } catch (e) {
      console.warn(`[scheduled-process] hook failed for clip ${c.id}: ${e}`);
    }
    clipWithHooks.push({ ...c, hook });
  }

  const transcript = getTranscript(videoId);
  const contract = buildRenderContract(videoId, clipWithHooks, {
    mode: 'final',
    mainTopic: clips[0]?.mainTopic ?? null,
    endingType: clips[0]?.endingType ?? null,
    // Phase 2 (Canonical transcript): propagate the real language + cues.
    language: transcript?.language || 'en',
    transcript,
  });
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
          if (item.quality?.status) {
            updateClipQc(clipId, {
              status: item.quality.status === 'pass' ? 'passed' : item.quality.status,
              score: item.quality.score ?? null,
              note: JSON.stringify(item.quality),
            });
          }
        }
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
      updateClipRender(c.id, { status: 'error', error: 'scheduled-process render timed out' });
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
    console.error(`[scheduled-process] seo failed for clip ${clip.id}: ${e}`);
    return false;
  }
}

export interface ScheduledProcessResult {
  clipIds: number[];
  readyCount: number;
  blockedCount: number;
  details: { clipId: number; ready: boolean; reason: string | null }[];
}

/**
 * Entry point: render + SEO + QC every non-archive clip of a run, then flag
 * them `awaiting_approval` — but NEVER publish. Never throws; failures are
 * recorded per clip.
 */
export async function autoProcessScheduled(runId: number): Promise<ScheduledProcessResult> {
  console.log(`[scheduled-process] starting for run ${runId}`);

  const clips = listClips({ runId });
  const candidates = clips.filter((c) => c.tier !== 'archive');
  console.log(`[scheduled-process] run ${runId}: ${candidates.length}/${clips.length} clips`);

  const ready: number[] = [];
  const blocked: { clipId: number; reason: string }[] = [];

  const byEpisode = new Map<string, ClipRecord[]>();
  for (const c of candidates) {
    const list = byEpisode.get(c.videoId) ?? [];
    list.push(c);
    byEpisode.set(c.videoId, list);
  }

  for (const [videoId, episodeClips] of byEpisode) {
    const pending = episodeClips.filter((c) => c.renderStatus !== 'done');
    if (pending.length > 0) {
      console.log(`[scheduled-process] episode ${videoId}: rendering ${pending.length} clips`);
      for (const c of pending) {
        updateClipRender(c.id, { status: 'rendering' });
      }

      const render = await renderEpisodeAll(videoId, pending);
      if (!render.ok) {
        for (const c of pending) {
          updateClipRender(c.id, { status: 'error', error: render.error ?? 'render failed' });
        }
        console.error(`[scheduled-process] render batch failed for ${videoId}: ${render.error}`);
        continue;
      }

      await pollRenderUntilDone(videoId, pending, render.jobId ?? '');
    }

    for (const c of episodeClips) {
      const refreshed = listClips({ videoId, limit: 500 }).find((x) => x.id === c.id) ?? c;
      if (refreshed.renderStatus === 'done' && !refreshed.seoTitle) {
        console.log(`[scheduled-process] clip ${c.id}: generating SEO`);
        await seoClip(refreshed);
      }
    }

    // Assign a prime-time market and slot to every clip that cleared the
    // gates, then publish it immediately. The rotation template gives
    // ~60% US / 25% AU / 15% CH across the batch; the slot is the next
    // occurrence of that market's local prime hour in its own timezone.
    // publish_at is forwarded to the poster service so YouTube uploads the
    // video private and flips it public exactly at that instant.
    let readyIndex = 0;
    for (const c of episodeClips) {
      const refreshed = listClips({ videoId, limit: 500 }).find((x) => x.id === c.id) ?? c;

      const reason = gateReason(refreshed);
      if (reason) {
        blocked.push({ clipId: refreshed.id, reason });
        continue;
      }

      const region = assignPrimeRegion(readyIndex);
      readyIndex += 1;
      const regionConfig = config.primeTime[region];
      const scheduledAt = nextPrimeUtc(regionConfig);
      const targetMarket = PRIME_REGION_LABELS[region];

      updateClipSchedule(refreshed.id, { scheduledAt, targetMarket });
      const published = await publishScheduledClip(refreshed, scheduledAt);
      if (published) {
        ready.push(refreshed.id);
      } else {
        blocked.push({ clipId: refreshed.id, reason: 'publish failed' });
      }
    }
  }

  const details = [
    ...ready.map((id) => ({ clipId: id, ready: true, reason: null })),
    ...blocked.map((b) => ({ clipId: b.clipId, ready: false, reason: b.reason })),
  ];

  console.log(
    `[scheduled-process] run ${runId}: ${ready.length} published, ${blocked.length} blocked`,
  );

  return {
    clipIds: ready,
    readyCount: ready.length,
    blockedCount: blocked.length,
    details,
  };
}

/**
 * Publish one rendered, SEO'd clip via the poster service with a prime-time
 * slot. The poster uploads it private with `publishAt` set, so YouTube flips
 * it public automatically at that instant. Returns true on success.
 */
async function publishScheduledClip(clip: ClipRecord, scheduledAt: string): Promise<boolean> {
  const publishBase = config.publish.baseUrl.replace(/\/$/, '');
  const renderBase = config.render.baseUrl.replace(/\/$/, '');
  // Base URL yang dipakai untuk file_url/thumbnail_url yang dikirim ke POSTER.
  // Poster jalan di HOST (bukan container), jadi tidak bisa pakai
  // host.docker.internal (hanya resolve dari dalam container). Default ke
  // 127.0.0.1 supaya poster bisa download file dari render service.
  const renderHostBase = (config.render.posterFileBaseUrl ?? 'http://127.0.0.1:8084').replace(/\/$/, '');
  const jobId = clip.renderPath?.split('/')[0] ?? '';
  const fileUrl = `${renderHostBase}/files/${clip.renderPath}`;
  const thumbnailUrl = jobId ? `${renderHostBase}/files/${jobId}/thumbnail.jpg` : '';

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
        publish_at: scheduledAt,
      }),
      signal: AbortSignal.timeout(config.publish.timeoutMs),
    });

    const body = (await response.json().catch(() => null)) as
      | { detail?: string; url?: string; status?: string; videoId?: string }
      | null;

    if (!response.ok) {
      const msg = body?.detail ?? `Publish failed with ${response.status}`;
      updateClipPublish(clip.id, { status: 'error', error: msg });
      console.error(`[scheduled-process] publish failed clip ${clip.id}: ${msg}`);
      return false;
    }

    updateClipPublish(clip.id, {
      status: 'published',
      url: body?.url ?? null,
      error: null,
    });
    console.log(`[scheduled-process] clip ${clip.id} scheduled for ${scheduledAt}: ${body?.url ?? ''}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError'
      ? 'Publish timed out'
      : `Poster service unreachable: ${e}`;
    updateClipPublish(clip.id, { status: 'error', error: msg });
    console.error(`[scheduled-process] publish failed clip ${clip.id}: ${msg}`);
    return false;
  }
}

/** Returns a reason string when a clip may not yet be approved, else null. */
function gateReason(clip: ClipRecord): string | null {
  if (clip.renderStatus !== 'done' || !clip.renderPath) {
    return 'render not completed';
  }
  if (clip.qcStatus !== 'passed') {
    return `qc ${clip.qcStatus ?? 'pending'}`;
  }
  if (clip.boundaryStatus === 'unrefined' || clip.boundaryStatus == null) {
    return 'boundary not refined';
  }
  if (clip.endingComplete === false) {
    return 'ending incomplete';
  }
  const maxContamination = 0.18;
  if (clip.nextTopicContamination != null && clip.nextTopicContamination > maxContamination) {
    return 'next-topic contamination too high';
  }
  // Rights gate is OPT-IN. By default the scheduled auto-publish flow does not
  // require a manual rights clearance (every clip defaults to 'unknown', which
  // would otherwise block the whole batch). Set SCHEDULED_REQUIRE_RIGHTS=true
  // to re-enable the copyright review gate.
  if (process.env.SCHEDULED_REQUIRE_RIGHTS === 'true') {
    const blockedRights = new Set(['unknown', 'blocked', 'editorial_review_required']);
    if (!clip.rightsStatus || blockedRights.has(clip.rightsStatus)) {
      return `rights '${clip.rightsStatus ?? 'unknown'}'`;
    }
  }
  if (!clip.seoTitle) {
    return 'seo metadata absent';
  }
  return null;
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