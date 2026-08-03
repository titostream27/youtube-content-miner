import { comparePredictionVsActual } from '@/lib/analytics/prediction';
import { listClips } from '@/lib/db/repositories/clips';
import { badRequest, notFound, ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/analytics/clips/:id/prediction
 *
 * Phase 3 (brief §27/§39) — compare the clip's predicted score (from mining)
 * against the actual measured performance.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const publishedCount = listClips({ limit: 100000 }).filter((c) => c.publishStatus === 'published').length;
  const result = comparePredictionVsActual(clipId, publishedCount);
  if (!result) return notFound('Clip not found');

  return ok(result);
}
