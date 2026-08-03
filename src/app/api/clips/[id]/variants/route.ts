import { getClip } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { generateClipVariants } from '@/lib/ai/agents/clip-variant-agent';
import { upsertVariant, listVariants } from '@/lib/db/repositories/variants';
import { badRequest, notFound, ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function clipTranscriptText(videoId: string, startSec: number, endSec: number): string {
  const transcript = getTranscript(videoId);
  if (!transcript) return '';
  return transcript.cues
    .filter((cue) => cue.startSec >= startSec && cue.startSec < endSec)
    .map((cue) => cue.text)
    .join(' ')
    .slice(0, 2000);
}

/**
 * Phase 4 (Master Task Brief §36/§39):
 *   GET  /api/clips/:id/variants  — list generated variants
 *   POST /api/clips/:id/variants  — generate Hook A/B/C variants (LLM + fallback)
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  return ok({ clipId, variants: listVariants(clipId) });
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  try {
    const transcriptText = clipTranscriptText(clip.videoId, clip.startSec, clip.endSec) || clip.transcript;
    const result = await generateClipVariants({
      clipId,
      transcript: transcriptText,
      clipTitle: clip.title,
      mainTopic: clip.mainTopic,
    });

    const variants = result.variants.map((v) =>
      upsertVariant({
        clipId,
        variantKey: v.key,
        hook: v.hook,
        title: v.title,
        captionEmphasis: v.captionEmphasis.join(', '),
        layoutPreference: v.layoutPreference,
        durationDeltaSec: v.durationDeltaSec,
        status: 'generated',
      }),
    );

    return ok({ clipId, variants, warnings: result.warnings });
  } catch (e) {
    return serverError(e);
  }
}
