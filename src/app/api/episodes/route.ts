import { countEpisodes, listEpisodes } from '@/lib/db/repositories/episodes';
import { ok, parseSearchParams, serverError } from '@/lib/api/http';
import { toEpisodeFilters } from '@/lib/api/filters';
import { episodeQuerySchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

/**
 * GET /api/episodes - the episode ranking (PRD Step 1 / Step 2 output).
 *
 *   /api/episodes?status=analysed&sort=clips
 */
export function GET(request: Request) {
  const { data, error } = parseSearchParams(request.url, episodeQuerySchema);
  if (error) return error;

  try {
    const filters = toEpisodeFilters(data);
    return ok({
      episodes: listEpisodes(filters),
      total: countEpisodes({ status: filters.status, channelId: filters.channelId }),
    });
  } catch (error) {
    return serverError(error);
  }
}
