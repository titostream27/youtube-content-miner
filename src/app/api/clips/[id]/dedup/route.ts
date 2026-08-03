import { getClip } from '@/lib/db/repositories/clips';
import { detectDuplicates, upsertEmbedding } from '@/lib/db/repositories/embeddings';
import { badRequest, notFound, ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/clips/:id/dedup
 *
 * Phase 3 (brief §32/§39) — compare this clip's transcript against every
 * other embedded clip. Returns verdicts: duplicate (>= 0.90), review
 * (0.78–0.90), ok.
 *
 * This endpoint also upserts the clip's embedding (text stored, vector null
 * until an embedding provider is configured — lexical fallback is used).
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  const text = clip.transcript || clip.suggestedCaption || '';
  if (text.trim().length < 10) {
    return badRequest('Clip has no transcript text to compare');
  }

  upsertEmbedding({ clipId, kind: 'clip', text });
  const results = detectDuplicates(clipId, text);

  return ok({
    clipId,
    verdict: results.some((r) => r.verdict === 'duplicate') ? 'duplicate' : results.some((r) => r.verdict === 'review') ? 'review' : 'ok',
    matches: results.slice(0, 10),
  });
}
