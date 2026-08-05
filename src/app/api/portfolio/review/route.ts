import { listClips, countClips } from '@/lib/db/repositories/clips';
import { ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/portfolio/review
 *
 * Phase 2 (Automation) — Review queue. Returns the clips the editor should
 * look at next: status 'new', sorted by score, highest first. Supports the
 * same query params as the clips list (?minScore=70&limit=25).
 *
 * This is the stable endpoint a Telegram notifier / review bot can poll.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const minScore = Number(url.searchParams.get('minScore') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 25);
  const createdSince = url.searchParams.get('createdSince') ?? undefined;

  const filters = {
    statuses: ['new' as const],
    minScore: Number.isFinite(minScore) && minScore > 0 ? minScore : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25,
    createdSince,
    sort: 'score' as const,
  };

  const clips = listClips(filters).map((c) => ({
    id: c.id,
    title: c.title,
    videoId: c.videoId,
    startSec: c.startSec,
    endSec: c.endSec,
    durationSec: c.durationSec,
    score: c.finalScore,
    confidence: c.confidence,
    tier: c.tier,
    category: c.category,
    mainTopic: c.mainTopic,
    episodeTitle: c.episodeTitle,
    channelTitle: c.channelTitle,
  }));
  const total = countClips(filters);

  return ok({ clips, total, queueSize: clips.length });
}
