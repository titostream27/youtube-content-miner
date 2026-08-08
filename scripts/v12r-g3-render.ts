/**
 * Brief V12R Phase O — Render production-selected silver-gold PASS clips.
 *
 * Selects PASS candidates (single-focus + multi-speaker), builds the render
 * request with REAL captions from the frozen transcript and production
 * semantic timestamps, submits to the render service (RENDER_SERVICE_URL,
 * default http://127.0.0.1:8084), downloads the MP4 artifacts into
 * evidence/v12r/g3/<clip_id>/, and saves render_request.json + switch
 * timeline evidence.
 *
 * Usage:
 *   node --import tsx scripts/v12r-g3-render.ts \
 *     --consensus evidence/v12r/consensus_labels.jsonl \
 *     --sample evidence/v12r/sample_manifest.json \
 *     --g2 evidence/v12r/production_g2.jsonl \
 *     --g3-out evidence/v12r/g3
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { cuesToUtterances } from '../src/lib/moments/utterances';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function apiBase(): string {
  return process.env.RENDER_SERVICE_URL?.replace(/\/+$/, '') ?? 'http://127.0.0.1:8084';
}

async function submitRender(videoUrl: string, clips: unknown[]): Promise<{ job_id: string }> {
  const res = await fetch(`${apiBase()}/api/render/async`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl, clips, aspect_ratio: '9:16' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`render submit failed ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as { job_id: string };
}

async function pollJob(jobId: string, timeoutMs = 900_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(`${apiBase()}/api/render/status/${jobId}`);
    const status = (await res.json()) as Record<string, unknown>;
    const state = String(status.status ?? status.state ?? 'unknown');
    if (['completed', 'partial_failure', 'failed', 'cancelled'].includes(state)) {
      return status;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`render job ${jobId} timed out at state ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    process.stderr.write(`[v12r-g3] poll ${jobId}: ${state}\n`);
  }
}

function captionLines(episodeId: string, startSec: number, endSec: number): { start_sec: number; end_sec: number; text: string; words: never[]; speaker: string }[] {
  const transcript = getTranscript(episodeId);
  if (!transcript) return [];
  const utterances = cuesToUtterances(transcript.cues);
  return utterances
    .filter((u) => u.endSec > startSec && u.startSec < endSec)
    .map((u) => ({
      start_sec: u.startSec,
      end_sec: u.endSec,
      text: u.text.replace(/\s+/g, ' ').trim(),
      words: [],
      speaker: u.speakerId ?? '',
    }));
}

async function download(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

async function main(): Promise<void> {
  const consensusPath = arg('consensus') ?? 'evidence/v12r/consensus_labels.jsonl';
  const samplePath = arg('sample') ?? 'evidence/v12r/sample_manifest.json';
  const h1Path = arg('h1') ?? 'evidence/v12r/h1_counterfactual.jsonl';
  const g3Out = arg('g3-out') ?? 'evidence/v12r/g3';

  const consensus = fs
    .readFileSync(path.resolve(consensusPath), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { label: string; episode_id: string; window: { start_sec: number; end_sec: number }; candidate_id: string })
    .filter((r) => r.label === 'PASS');

  // H1-repaired candidates that became silver PASS after expansion.
  if (fs.existsSync(path.resolve(h1Path))) {
    for (const line of fs.readFileSync(path.resolve(h1Path), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as Record<string, unknown>;
      const rejudged = rec.rejudged as { label: string } | null;
      if (rejudged?.label === 'PASS' && rec.candidate_id && rec.episode_id && rec.expanded_start_sec !== null && rec.expanded_end_sec !== null) {
        consensus.push({
          label: 'PASS',
          episode_id: String(rec.episode_id),
          candidate_id: `${String(rec.candidate_id)}.h1`,
          window: { start_sec: Number(rec.expanded_start_sec), end_sec: Number(rec.expanded_end_sec) },
        });
      }
    }
  }

  const sample = JSON.parse(fs.readFileSync(path.resolve(samplePath), 'utf-8')) as { sample: { candidate_id: string; episode_id: string; window: { start_sec: number; end_sec: number }; stratum: string }[] };
  const byId = new Map(sample.sample.map((e) => [e.candidate_id, e]));

  if (consensus.length === 0) {
    console.log(JSON.stringify({ selected: 0, error: 'no silver-gold PASS candidates available to render' }, null, 2));
    return;
  }

  // Keep candidates with their sample metadata; mark multi-speaker by
  // transcript evidence later.
  interface Selected {
    candidate_id: string;
    episode_id: string;
    start_sec: number;
    end_sec: number;
    stratum: string;
  }
  const selected: Selected[] = consensus
    .map((r) => {
      const baseId = r.candidate_id.replace(/\.h1$/, '');
      const e = byId.get(baseId);
      return e
        ? { candidate_id: r.candidate_id, episode_id: r.episode_id, start_sec: r.window.start_sec, end_sec: r.window.end_sec, stratum: e.stratum }
        : null;
    })
    .filter((x): x is Selected => x !== null);

  // Distinguish multi-speaker candidates using the transcript's speaker labels.
  const speakerSwitch = (c: Selected): boolean => {
    const tr = getTranscript(c.episode_id);
    if (!tr) return false;
    const utts = cuesToUtterances(tr.cues).filter((u) => u.endSec > c.start_sec && u.startSec < c.end_sec);
    const speakers = new Set(utts.map((u) => u.speakerId).filter(Boolean));
    return speakers.size >= 2;
  };

  const multi = selected.filter(speakerSwitch);
  const single = selected.filter((c) => !speakerSwitch(c));
  const pickMulti = multi.slice(0, 2);
  const pickSingle = single.slice(0, 1);
  const chosen = [...pickMulti, ...pickSingle];
  if (chosen.length < 3) {
    // Fill with remaining PASS candidates (brief requires >=3; prefer multi).
    for (const c of [...multi.slice(2), ...single.slice(1)]) {
      if (chosen.length >= 3) break;
      chosen.push(c);
    }
  }

  fs.mkdirSync(path.resolve(g3Out), { recursive: true });
  const renderSummary: Record<string, unknown>[] = [];

  for (const clip of chosen) {
    const clipDir = path.join(g3Out, clip.candidate_id);
    fs.mkdirSync(path.resolve(clipDir), { recursive: true });
    const videoUrl = `https://www.youtube.com/watch?v=${clip.episode_id}`;
    // Clamp to the production hard max (60s) so rendered clips respect the
    // same duration invariant as production candidates.
    const startSec = clip.start_sec;
    const endSec = Math.min(clip.end_sec, startSec + 60);
    const request = {
      clip_id: clip.candidate_id,
      episode_id: clip.episode_id,
      video_url: videoUrl,
      clips: [
        {
          clip_id: clip.candidate_id,
          title: `v12r-${clip.candidate_id}`,
          start_sec: startSec,
          end_sec: endSec,
          hook: '',
          captions: captionLines(clip.episode_id, startSec, endSec),
        },
      ],
      aspect_ratio: '9:16',
      sampled_at: new Date().toISOString(),
      selection_note: `${clip.stratum}${speakerSwitch(clip) ? ' · MULTI_SPEAKER' : ' · SINGLE_FOCUS'}`,
      hard_max_clamp_applied: clip.end_sec !== endSec,
    };
    fs.writeFileSync(path.join(clipDir, 'render_request.json'), JSON.stringify(request, null, 2), 'utf-8');

    try {
      const { job_id } = await submitRender(videoUrl, request.clips);
      const status = await pollJob(job_id);
      const nested = (status.response ?? status) as Record<string, unknown>;
      const artifacts = (nested.artifacts ?? []) as Record<string, unknown>[];
      const artifact = artifacts.find((a) => String(a.clip_id) === clip.candidate_id) ?? artifacts[0];
      fs.writeFileSync(path.join(clipDir, 'job_status.json'), JSON.stringify(status, null, 2), 'utf-8');

      const videoUrlFinal = artifact?.video_url ? String(artifact.video_url) : null;
      const localMp4 = path.join(clipDir, 'clip.mp4');
      if (videoUrlFinal) {
        // Renderer returns a relative path (job_id/filename); resolve it
        // against the service's /files endpoint.
        const absUrl = videoUrlFinal.startsWith('http')
          ? videoUrlFinal
          : `${apiBase()}/files/${videoUrlFinal}`;
        await download(absUrl, localMp4);
        renderSummary.push({ candidate_id: clip.candidate_id, episode_id: clip.episode_id, ok: true, artifact_status: artifact?.status, local_mp4: localMp4 });
      } else {
        renderSummary.push({ candidate_id: clip.candidate_id, episode_id: clip.episode_id, ok: false, error: 'no video_url in artifact', artifact_status: artifact?.status });
      }
    } catch (error) {
      renderSummary.push({ candidate_id: clip.candidate_id, episode_id: clip.episode_id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  console.log(JSON.stringify({ selected: chosen.length, results: renderSummary }, null, 2));
}

void main();