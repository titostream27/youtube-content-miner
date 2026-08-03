import { listEpisodeMetricSnapshots, computeTrendScores } from '@/lib/db/repositories/episode-metrics';
import { listCommentSignals } from '@/lib/analytics/comment-mining';
import { getEpisode } from '@/lib/db/repositories/episodes';
import { ok, notFound } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

/**
 * GET /api/episodes/:videoId/trend
 *
 * Phase 4 (brief §20/§30) — trend/evergreen/breakout scores for an episode
 * from its metric snapshots, plus popular comment timestamps that could seed
 * new candidates (they still must pass boundary + quality scoring).
 */
export async function GET(_request: Request, context: RouteContext) {
  const { videoId } = await context.params;
  const episode = getEpisode(videoId);
  if (!episode) return notFound('Episode not found');

  const snaps = listEpisodeMetricSnapshots(videoId);
  const older = snaps.length >= 2 ? snaps[0]! : null;
  const newer = snaps.length > 0 ? snaps[snaps.length - 1]! : null;
  const scores = computeTrendScores(older, newer, 24);

  const signals = listCommentSignals(videoId);
  const hotTimestamps = signals
    .filter((s) => s.kind === 'timestamp_mention' && typeof s.payload.timeSec === 'number')
    .map((s) => ({ timeSec: Number(s.payload.timeSec), mentionCount: Number(s.payload.mentionCount ?? 1) }))
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, 10);

  return ok({
    videoId,
    title: episode.title,
    snapshots: snaps.length,
    trend: scores,
    commentSeededCandidates: hotTimestamps,
  });
}
