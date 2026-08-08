/**
 * Brief V12R Phase O — Automated visual judge for G3 clips.
 *
 * Samples frames already extracted by v12r-g3-qc.ts and asks a vision-capable
 * judge model (default: cx/gpt-5.6-luna via the local 9router gateway) to
 * evaluate the brief's visual dimensions using sampled frames. Frame-based
 * evidence is explicitly a PROXY for full-motion smoothness (brief §18.2).
 *
 * Usage:
 *   node --import tsx scripts/v12r-g3-visual-judge.ts \
 *     --g3-dir evidence/v12r/g3 \
 *     [--model cx/gpt-5.6-luna] [--base-url http://127.0.0.1:20128/v1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const visualJudgeSchema = z.object({
  face_framing: z.enum(['PASS', 'REVIEW', 'FAIL']),
  active_speaker_alignment: z.enum(['PASS', 'REVIEW', 'FAIL']),
  switch_smoothness_proxy: z.enum(['PASS', 'REVIEW', 'FAIL']),
  ping_pong_risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  caption_face_collision: z.enum(['NONE', 'MINOR', 'MAJOR']),
  head_cutoff: z.enum(['NONE', 'MINOR', 'MAJOR']),
  layout_stability: z.enum(['PASS', 'REVIEW', 'FAIL']),
  notes: z.array(z.string()),
});

async function main(): Promise<void> {
  const g3Dir = arg('g3-dir') ?? 'evidence/v12r/g3';
  const model = arg('model') ?? 'cx/gpt-5.6-luna';
  const baseUrl = arg('base-url') ?? 'http://127.0.0.1:20128/v1';
  const key = process.env.V12R_VISION_API_KEY ?? '';

  const clipDirs = fs
    .readdirSync(path.resolve(g3Dir), { withFileTypes: true })
    .filter((d) => d.isDirectory());
  const outputs: Record<string, unknown>[] = [];

  for (const d of clipDirs) {
    const dir = path.join(g3Dir, d.name);
    const framesDir = path.join(dir, 'frames');
    const result: Record<string, unknown> = { clip_id: d.name };
    if (!fs.existsSync(path.join(dir, 'clip.mp4')) || !fs.existsSync(framesDir)) {
      result.status = 'skipped_no_frames';
      outputs.push(result);
      continue;
    }
    const frames = fs
      .readdirSync(framesDir)
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .slice(0, 8);
    if (frames.length === 0) {
      result.status = 'skipped_no_frames';
      outputs.push(result);
      continue;
    }

    const content: Record<string, unknown>[] = [
      {
        type: 'text',
        text: [
          'You are the VISUAL judge for a short-form video clip (9:16). Analyze the sampled frames below.',
          'Rate: face_framing, active_speaker_alignment, switch_smoothness_proxy, ping_pong_risk,',
          'caption_face_collision, head_cutoff, layout_stability. Frames are a proxy — never claim',
          'full-motion smoothness from stills; label the smoothness rating as a proxy.',
          'Respond with ONLY JSON: {"face_framing":"PASS|REVIEW|FAIL","active_speaker_alignment":"PASS|REVIEW|FAIL",',
          '"switch_smoothness_proxy":"PASS|REVIEW|FAIL","ping_pong_risk":"LOW|MEDIUM|HIGH",',
          '"caption_face_collision":"NONE|MINOR|MAJOR","head_cutoff":"NONE|MINOR|MAJOR",',
          '"layout_stability":"PASS|REVIEW|FAIL","notes":[]}',
        ].join(' '),
      },
    ];
    for (const f of frames) {
      const b64 = fs.readFileSync(path.join(framesDir, f)).toString('base64');
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
    }

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          max_tokens: 800,
          stream: false,
          response_format: { type: 'json_object' },
        }),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      const text = String(((payload.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content) ?? '');
      let parsed: unknown;
      try {
        const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text.trim());
        parsed = JSON.parse(fenced?.[1] ?? text.trim());
      } catch {
        result.status = 'parse_failure';
        result.raw = text.slice(0, 1000);
        outputs.push(result);
        continue;
      }
      const validated = visualJudgeSchema.safeParse(parsed);
      if (!validated.success) {
        result.status = 'schema_failure';
        result.issues = validated.error.issues.map((i) => `${i.path.join('.')}:${i.message}`);
        outputs.push(result);
        continue;
      }
      result.status = 'ok';
      result.frames_used = frames.length;
      result.visual_judge = validated.data;
      result.method = 'sampled_frames_proxy';
    } catch (error) {
      result.status = 'provider_error';
      result.error = error instanceof Error ? error.message : String(error);
    }
    outputs.push(result);
  }

  fs.writeFileSync(path.resolve(g3Dir, 'visual_judge_summary.json'), JSON.stringify(outputs, null, 2), 'utf-8');
  console.log(JSON.stringify(outputs, null, 2));
}

void main();