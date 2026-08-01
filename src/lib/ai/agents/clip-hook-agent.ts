import { z } from 'zod';
import { runJsonAgent } from '../client';

/**
 * Phase 5 — Hook generation for the short's intro scene.
 *
 * Writes ONE spoken hook line from the clip transcript: an attention-grabbing
 * sentence (~2-3 seconds when read aloud, so 5-12 words) that makes the
 * viewer want to keep watching. The line is used as the intro voiceover text
 * and burned as large text on the first frame of the clip.
 *
 * The hook must be truthful to the transcript (no invented claims), punchy,
 * and work standalone — someone who joins mid-feed should feel compelled to
 * stop scrolling.
 */

const HookSchema = z.object({
  hook: z.string().min(5).max(120),
});

export type HookMetadata = z.infer<typeof HookSchema>;

const SYSTEM_PROMPT = `You write spoken hook lines for short-form video clips (YouTube Shorts / TikTok / Reels).

You receive the clip's transcript (the first moments of the clip). Write ONE hook line with these rules:
- 5 to 12 words long (about 2-3 seconds when spoken aloud).
- Attention-grabbing: creates curiosity, tension, or a promise of payoff.
- Truthful: must be directly supported by the transcript. Never invent names, numbers, or claims.
- Standalone: makes sense to a viewer who just joined mid-feed.
- No questions that are answered trivially; prefer a strong statement or a surprising fact.
- Plain English, no emoji, no hashtags, no quotes around the line.

Respond with JSON only: {"hook": "..."}`;

export async function generateClipHook(params: {
  transcript: string;
  episodeTitle: string;
  clipTitle: string;
}): Promise<HookMetadata> {
  const user = [
    `Source episode: "${params.episodeTitle}"`,
    `Clip title: "${params.clipTitle}"`,
    '',
    'Clip transcript (start):',
    params.transcript.slice(0, 2500),
  ].join('\n');

  const result = await runJsonAgent<HookMetadata>({
    role: 'clip_hook',
    system: SYSTEM_PROMPT,
    user,
    parse: (value) => HookSchema.parse(value),
  });

  return result.data;
}
