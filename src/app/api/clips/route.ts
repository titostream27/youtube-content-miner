import { clipCategoryBreakdown, countClips, listClips } from '@/lib/db/repositories/clips';
import { ok, parseSearchParams, serverError } from '@/lib/api/http';
import { toClipFilters } from '@/lib/api/filters';
import { clipQuerySchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

/**
 * GET /api/clips
 *
 * The clip library. Filter by tier, category, status, episode, channel, run,
 * minimum score and minimum confidence.
 *
 *   /api/clips?tier=publish_immediately,high_priority&minConfidence=85&sort=score
 */
export function GET(request: Request) {
  const { data, error } = parseSearchParams(request.url, clipQuerySchema);
  if (error) return error;

  try {
    const filters = toClipFilters(data);

    return ok({
      clips: listClips(filters),
      total: countClips({ ...filters, limit: undefined, offset: undefined }),
      categories: clipCategoryBreakdown({ ...filters, limit: undefined, offset: undefined }),
    });
  } catch (error) {
    return serverError(error);
  }
}
