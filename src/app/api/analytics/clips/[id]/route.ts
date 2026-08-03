import { getClip } from '@/lib/db/repositories/clips';
import {
  getLatestAnalytics,
  listAnalyticsByWindow,
} from '@/lib/db/repositories/analytics';
import { badRequest, notFound, ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/analytics/clips/:id
 *
 * Phase 3 (brief §26/§39) — return the latest analytics snapshot for a clip
 * plus the latest snapshot per window (24/72/168/672h) for trend view.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  const latest = getLatestAnalytics(clipId);
  const windows = [24, 72, 168, 672]
    .map((w) => {
      const snaps = listAnalyticsByWindow(clipId, w);
      return snaps.length > 0 ? { windowHours: w, snapshot: snaps[snaps.length - 1] } : null;
    })
    .filter((x): x is { windowHours: number; snapshot: NonNullable<typeof latest> } => x !== null && x.snapshot !== null);

  return ok({
    clipId,
    title: clip.title,
    publishUrl: clip.publishUrl,
    latest: latest
      ? {
          views: latest.views,
          viewedRate: latest.viewedRate,
          avgPercentageViewed: latest.avgPercentageViewed,
          retention3s: latest.retention3s,
          likes: latest.likes,
          comments: latest.comments,
          shares: latest.shares,
          capturedAt: latest.capturedAt,
          windowHours: latest.snapshotWindowHours,
        }
      : null,
    byWindow: windows.map((w) => ({
      windowHours: w.windowHours,
      views: w.snapshot.views,
      retention3s: w.snapshot.retention3s,
      capturedAt: w.snapshot.capturedAt,
    })),
  });
}
