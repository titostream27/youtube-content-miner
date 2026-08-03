import { listCommentSignals } from '@/lib/analytics/comment-mining';
import { ok, badRequest } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/comments/signals?videoId=...
 *
 * Phase 3 (brief §31/§39) — return mined comment signals for a video.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('videoId');
  if (!videoId) return badRequest('Missing videoId query param');

  const signals = listCommentSignals(videoId);
  return ok({ videoId, signals, count: signals.length });
}
