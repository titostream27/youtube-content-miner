/**
 * Brief V12R Phase O — Automated technical QC for rendered G3 clips.
 *
 * For each rendered clip under evidence/v12r/g3/<clip_id>/:
 *   - ffprobe codec/resolution/pixel format/duration/fps/audio metadata
 *   - black-frame + frozen-frame checks (ffmpeg blackdetect/freezedetect)
 *   - caption coverage/timing checks from render_request.json
 *   - frame sampling (start/mid/end + around speaker switches) into frames/
 *
 * Outputs per clip: ffprobe.txt, qc.json.
 *
 * Usage:
 *   node --import tsx scripts/v12r-g3-qc.ts --g3-dir evidence/v12r/g3
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function run(cmd: string, args: string[]): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr: '' };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

function ffprobeJson(mp4: string): Record<string, unknown> | null {
  const { stdout } = run('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', mp4,
  ]);
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectBadFrames(mp4: string, mode: 'black' | 'freeze'): { events: string[]; ratio: number } {
  const filter = mode === 'black' ? 'blackdetect=d=0.2:pix_th=0.10' : 'freezedetect=n=-60dB:d=2';
  const { stderr } = run('ffmpeg', ['-hide_banner', '-i', mp4, '-vf', filter, '-an', '-f', 'null', '-']);
  const events = stderr
    .split('\n')
    .filter((l) => l.includes(mode === 'black' ? 'black_start' : 'freeze_start'))
    .map((l) => l.trim());
  // Durations: probe duration from ffprobe for the ratio denominator.
  const info = ffprobeJson(mp4);
  const dur = Number((info?.format as Record<string, unknown> | undefined)?.duration ?? 0);
  let badSec = 0;
  for (const line of events) {
    const m = /(?:black|freeze)_duration:([0-9.]+)/.exec(line);
    if (m) badSec += Number.parseFloat(m[1]!);
  }
  return { events, ratio: dur > 0 ? Math.min(1, badSec / dur) : 0 };
}

function sampleFrames(mp4: string, outDir: string, extraTimes: number[] = []): string[] {
  const info = ffprobeJson(mp4);
  const dur = Number((info?.format as Record<string, unknown> | undefined)?.duration ?? 0);
  if (dur <= 0) return [];
  const times = new Set<number>([
    Math.round(dur * 0.05 * 10) / 10,
    Math.round(dur * 0.3 * 10) / 10,
    Math.round(dur * 0.6 * 10) / 10,
    Math.round(dur * 0.95 * 10) / 10,
    ...extraTimes.map((t) => Math.round(t * 10) / 10),
  ]);
  const files: string[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t < 0 || t > dur) continue;
    const out = path.join(outDir, `frame_${String(t).replace('.', '_')}.jpg`);
    const { stderr } = run('ffmpeg', [
      '-hide_banner', '-ss', String(t), '-i', mp4, '-frames:v', '1',
      '-vf', 'scale=360:-2', '-q:v', '4', '-y', out,
    ]);
    if (stderr.length === 0 && fs.existsSync(out)) files.push(out);
  }
  return files;
}

function main(): void {
  const g3Dir = arg('g3-dir') ?? 'evidence/v12r/g3';
  const clipDirs = fs
    .readdirSync(path.resolve(g3Dir), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (clipDirs.length === 0) {
    console.log(JSON.stringify({ error: 'no clip directories found' }, null, 2));
    return;
  }

  const results: Record<string, unknown>[] = [];

  for (const clipId of clipDirs) {
    const dir = path.join(g3Dir, clipId);
    const mp4 = path.join(dir, 'clip.mp4');
    const result: Record<string, unknown> = { clip_id: clipId };
    if (!fs.existsSync(mp4)) {
      result.ok = false;
      result.error = 'clip.mp4 missing';
      results.push(result);
      continue;
    }

    // Full ffprobe text artifact.
    const probeText = run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', mp4]).stdout;
    fs.writeFileSync(path.join(dir, 'ffprobe.txt'), probeText || '(ffprobe produced no output)', 'utf-8');

    const probe = ffprobeJson(mp4);
    const video = (probe?.streams as Record<string, unknown>[] | undefined)?.find((s) => s.codec_type === 'video');
    const audio = (probe?.streams as Record<string, unknown>[] | undefined)?.filter((s) => s.codec_type === 'audio');
    const format = probe?.format as Record<string, unknown> | undefined;

    const black = detectBadFrames(mp4, 'black');
    const freeze = detectBadFrames(mp4, 'freeze');

    // Caption coverage from the render request.
    let captionCoverage: Record<string, unknown> = { lines: 0, covered_sec: 0, duration_sec: 0 };
    const reqPath = path.join(dir, 'render_request.json');
    if (fs.existsSync(reqPath)) {
      const req = JSON.parse(fs.readFileSync(reqPath, 'utf-8')) as { clips: { start_sec: number; end_sec: number; captions: { start_sec: number; end_sec: number }[] }[] };
      const clipReq = req.clips[0];
      if (clipReq) {
        const dur = clipReq.end_sec - clipReq.start_sec;
        const covered = clipReq.captions.reduce((sum, c) => sum + Math.max(0, c.end_sec - c.start_sec), 0);
        captionCoverage = { lines: clipReq.captions.length, covered_sec: Math.round(covered * 10) / 10, duration_sec: Math.round(dur * 10) / 10 };
      }
    }

    const framesDir = path.join(dir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    const switchTimelinePath = path.join(dir, 'switch_timeline.json');
    let extraTimes: number[] = [];
    if (fs.existsSync(switchTimelinePath)) {
      const tl = JSON.parse(fs.readFileSync(switchTimelinePath, 'utf-8')) as { switches: { at_sec: number }[] };
      extraTimes = (tl.switches ?? []).map((s) => s.at_sec);
    }
    const frames = sampleFrames(mp4, framesDir, extraTimes);

    const duration = Number(video?.duration ?? format?.duration ?? 0);
    result.ok = true;
    result.technical_qc = {
      codec: video?.codec_name ?? null,
      resolution: video?.width && video?.height ? `${video.width}x${video.height}` : null,
      pixel_format: video?.pix_fmt ?? null,
      duration_sec: Math.round(duration * 100) / 100,
      fps: video?.avg_frame_rate ?? video?.r_frame_rate ?? null,
      audio_streams: audio?.map((a) => ({ codec: a.codec_name, channels: a.channels, sample_rate: a.sample_rate })) ?? [],
      black_frame_ratio: Math.round(black.ratio * 1000) / 1000,
      black_frame_events: black.events.length,
      frozen_frame_ratio: Math.round(freeze.ratio * 1000) / 1000,
      frozen_frame_events: freeze.events.length,
      caption_coverage: captionCoverage,
      frames_sampled: frames.length,
    };
    result.passes = {
      h264_or_h265: ['h264', 'h265', 'hevc'].includes(String(video?.codec_name ?? '')),
      yuv420p: video?.pix_fmt === 'yuv420p',
      positive_duration: duration > 0,
      low_black_frames: black.ratio < 0.05,
      low_frozen_frames: freeze.ratio < 0.05,
      captions_present: (captionCoverage.lines as number) > 0,
    };
    results.push(result);
  }

  console.log(JSON.stringify(results, null, 2));
}

main();