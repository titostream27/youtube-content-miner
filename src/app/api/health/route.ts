import { describeConfig } from '@/lib/config';
import { getLibraryTotals } from '@/lib/db/repositories/stats';
import { getQuotaUsed } from '@/lib/youtube/client';
import { ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health
 *
 * Liveness plus the two things that actually break this app in production:
 * whether the database is reachable, and how much YouTube quota the current
 * process has consumed.
 */
export function GET() {
  try {
    const totals = getLibraryTotals();
    const summary = describeConfig();

    return ok({
      status: 'ok',
      database: 'connected',
      discovery: summary.youtube,
      scoring: summary.scoring,
      defaultProvider: summary.defaultProvider,
      configuredProviders: summary.configuredProviders.map((provider) => provider.id),
      youtubeQuotaUsedThisProcess: getQuotaUsed(),
      library: {
        episodesDiscovered: totals.episodesDiscovered,
        episodesAnalysed: totals.episodesAnalysed,
        clipsInLibrary: totals.clipsInLibrary,
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
