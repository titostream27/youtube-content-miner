import { z } from 'zod';
import { runJsonAgent } from '@/lib/ai/client';
import type { UsageLedger } from '@/lib/ai/client';

/**
 * Phase 4 (Master Task Brief §36) — clip variant generation.
 *
 * For high-quality clips generate up to three metadata variants:
 *   Hook A: outcome first
 *   Hook B: direct question
 *   Hook C: controversial statement
 *
 * Variants may differ in: hook, title, caption emphasis, layout preference,
 * small duration boundary delta. They are NOT final-rendered immediately.
 */

const VariantSchema = z.object({
  variants: z
    .array(
      z.object({
        key: z.enum(['hook_a', 'hook_b', 'hook_c']),
        hook: z.string().min(5).max(160),
        title: z.string().min(5).max(160),
        caption_emphasis: z.array(z.string()).max(4),
        layout_preference: z.enum(['auto', 'face_crop', 'dual_face', 'blur_background']).optional(),
        duration_delta_sec: z.number().min(-6).max(6).optional(),
      }),
    )
    .min(1)
    .max(3),
});

export interface VariantGenerationResult {
  clipId: number;
  variants: {
    key: 'hook_a' | 'hook_b' | 'hook_c';
    hook: string;
    title: string;
    captionEmphasis: string[];
    layoutPreference?: string;
    durationDeltaSec?: number;
  }[];
  warnings: string[];
}

export async function generateClipVariants(opts: {
  clipId: number;
  transcript: string;
  clipTitle: string;
  mainTopic?: string | null;
  ledger?: UsageLedger;
  signal?: AbortSignal;
}): Promise<VariantGenerationResult> {
  const warnings: string[] = [];
  const system = `You are a YouTube Shorts metadata strategist. For one clip, propose up to THREE hook variants:
- Hook A "outcome first": lead with the payoff/result
- Hook B "direct question": ask the viewer a question the clip answers
- Hook C "controversial statement": a bold claim that invites engagement
Return hooks and titles that are concrete and factual to the transcript (never fabricated). Keep titles <= 160 chars.
Return your answer as a JSON object matching this schema: {"variants": [{"key": "hook_a|hook_b|hook_c", "hook": "...", "title": "...", "caption_emphasis": [...], "layout_preference": "auto|face_crop|dual_face|blur_background", "duration_delta_sec": 0}]}. JSON output only.`;

  const user = [
    `Clip title: ${opts.clipTitle}`,
    opts.mainTopic ? `Main topic: ${opts.mainTopic}` : '',
    `Transcript (first 2000 chars):`,
    opts.transcript.slice(0, 2000),
  ]
    .filter(Boolean)
    .join('\n\n');

  let data: z.infer<typeof VariantSchema>;
  try {
    const result = await runJsonAgent<z.infer<typeof VariantSchema>>({
      role: 'clip_variants',
      system,
      user,
      parse: (value) => VariantSchema.parse(value),
      ledger: opts.ledger,
      signal: opts.signal,
      temperature: 0.7,
    });
    data = result.data;
  } catch (e) {
    warnings.push(`variant generation failed: ${e instanceof Error ? e.message : e}`);
    // Deterministic fallback: build three generic-but-safe variants locally.
    const base = opts.clipTitle.slice(0, 80);
    data = {
      variants: [
        { key: 'hook_a', hook: 'Here is what happened next.', title: base, caption_emphasis: [] },
        { key: 'hook_b', hook: `Do you know why ${opts.mainTopic ?? 'this'} matters?`, title: base, caption_emphasis: [] },
        { key: 'hook_c', hook: 'Most people get this wrong.', title: base, caption_emphasis: [] },
      ],
    };
  }

  return {
    clipId: opts.clipId,
    variants: data.variants.map((v) => ({
      key: v.key,
      hook: v.hook,
      title: v.title,
      captionEmphasis: v.caption_emphasis,
      layoutPreference: v.layout_preference,
      durationDeltaSec: v.duration_delta_sec,
    })),
    warnings,
  };
}
