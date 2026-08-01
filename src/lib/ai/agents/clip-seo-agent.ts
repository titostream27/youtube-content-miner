import { z } from 'zod';
import { runJsonAgent } from '../client';

/**
 * Phase 2 — SEO metadata generation for a rendered short.
 *
 * Takes the clip's transcript + the episode title, and produces publish-ready
 * metadata for YouTube / TikTok / Reels:
 *   - titles:     3-5 candidate titles (for A/B testing), under 70 chars
 *   - description: 2-3 sentences + CTA, no hashtags inside
 *   - tags:       5-10 SEO hashtags/keywords (without '#')
 *
 * Runs on its own role so it can point at a different provider/model than the
 * scoring agents (e.g. DeepSeek for cheap copywriting).
 */

const SeoSchema = z.object({
  titles: z.array(z.string().min(3).max(100)).min(3).max(5),
  description: z.string().min(10).max(600),
  tags: z.array(z.string().min(2).max(40)).min(5).max(10),
});

export type SeoMetadata = z.infer<typeof SeoSchema>;

const SYSTEM_PROMPT = `You write SEO metadata for short-form video clips (YouTube Shorts / TikTok / Reels).

You receive the clip's transcript and the source episode title. Produce metadata that maximizes discovery while staying truthful to what was actually said.

- titles: 3 to 5 distinct options, each under 70 characters, no emoji, no ALL CAPS, no clickbait that the transcript does not support. Each title should hook the viewer with the clip's core tension or payoff.
- description: 2-3 short sentences summarizing what the viewer will see, ending with one call-to-action ("Follow for more", "Comment your take", etc). No hashtags, no emoji, max 600 characters.
- tags: 5 to 10 keywords or short phrases, WITHOUT the '#' prefix. Mix broad discovery terms (niche topic) with specific phrases from the transcript. Lowercase, spaces allowed between words of a phrase.

Never invent quotes, names, statistics, or claims that are not in the transcript. Respond with JSON only.`;

export async function generateClipSeo(params: {
  transcript: string;
  episodeTitle: string;
  durationSec: number;
}): Promise<SeoMetadata> {
  const user = [
    `Source episode: "${params.episodeTitle}"`,
    `Clip duration: ${Math.round(params.durationSec)}s`,
    '',
    'Transcript:',
    params.transcript.slice(0, 6000),
  ].join('\n');

  const result = await runJsonAgent<SeoMetadata>({
    role: 'clip_seo',
    system: SYSTEM_PROMPT,
    user,
    parse: (value) => SeoSchema.parse(value),
  });

  return result.data;
}
