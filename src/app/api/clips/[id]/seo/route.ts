import { getClip, updateClipSeo } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { generateClipSeo } from '@/lib/ai/agents/clip-seo-agent';
import { AgentUnavailableError } from '@/lib/ai/client';
import { badRequest, notFound, ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/clips/:id/seo
 *
 * Phase 2 — generate SEO metadata (titles, description, hashtags) for a clip
 * using the LLM agent (DeepSeek by default). Reads the clip's stored
 * transcript, calls the agent, and persists the result.
 *
 * Response: { seo: { titles: string[], description: string, tags: string[] } }
 */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);

  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  try {
    const clip = getClip(clipId);
    if (!clip) return notFound('Clip not found');

    // Prefer the stored clip transcript; fall back to the full transcript
    // (clip.transcript may be empty when the episode was scored heuristically).
    let transcript = clip.transcript.trim();
    if (!transcript) {
      const full = getTranscript(clip.videoId);
      transcript = (full?.cues ?? [])
        .filter((cue) => cue.startSec >= clip.startSec && cue.startSec < clip.endSec)
        .map((cue) => cue.text)
        .join(' ')
        .trim();
    }
    if (!transcript) {
      return badRequest('No transcript available for this clip');
    }

    const seo = await generateClipSeo({
      transcript,
      episodeTitle: clip.episodeTitle,
      durationSec: clip.durationSec,
    });

    updateClipSeo(clipId, {
      title: seo.titles[0] ?? clip.title,
      description: seo.description,
      tags: seo.tags,
    });

    return ok({ seo });
  } catch (err) {
    if (err instanceof AgentUnavailableError) {
      return serverError(`SEO agent unavailable: ${err.message}`);
    }
    console.error('[seo] generation failed', err);
    return serverError('SEO generation failed');
  }
}
