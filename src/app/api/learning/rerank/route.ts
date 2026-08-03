import { computeReRankAdjustments } from '@/lib/analytics/learning';
import { ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/learning/rerank
 *
 * Phase 4 (brief §24/§39) — compute re-ranking weight adjustments from
 * analytics. Adjustments are only applied when the sample threshold
 * (LEARNING_MIN_PUBLISHED_CLIPS=30) is met.
 */
export async function GET() {
  return ok(computeReRankAdjustments());
}
