import { getClip } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { computeMarketFit, MARKETS, type MarketCode } from '@/lib/market/market-fit';
import { getDb, nowIso } from '@/lib/db/client';
import { badRequest, notFound, ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function persistMarketFit(clipId: number, result: { marketFit: Record<MarketCode, number>; recommendedMarket: MarketCode; reasons: string[] }): void {
  const now = nowIso();
  const db = getDb();
  for (const market of MARKETS) {
    db.prepare(
      `INSERT INTO market_fit_scores (clip_id, market, score, recommended_market, reasons, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(clip_id, market) DO UPDATE SET
         score = excluded.score,
         recommended_market = excluded.recommended_market,
         reasons = excluded.reasons,
         computed_at = excluded.computed_at`,
    ).run(clipId, market, result.marketFit[market], result.recommendedMarket, JSON.stringify(result.reasons), now);
  }
}

/**
 * GET /api/clips/:id/market-fit
 *
 * Phase 3 (Master Task Brief §29/§39) — compute and persist market fit for
 * US / AU / CH-EN / CH-DE / CH-FR / CH-IT from clip signals.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  const transcript = getTranscript(clip.videoId);
  const transcriptText = (transcript?.cues ?? [])
    .filter((cue) => cue.startSec >= clip.startSec && cue.startSec < clip.endSec)
    .map((cue) => cue.text)
    .join(' ')
    .slice(0, 4000);

  const result = computeMarketFit({
    hook: clip.suggestedHook || clip.title,
    transcript: transcriptText,
    guestName: null,
    publishingTz: clip.targetMarket?.includes('CH') ? 'Europe/Zurich' : clip.targetMarket?.includes('US') ? 'America/New_York' : null,
  });

  persistMarketFit(clipId, result);

  return ok({ clipId, ...result });
}
