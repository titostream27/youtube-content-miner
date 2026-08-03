import { z } from 'zod';
import { listPortfolioSuggestions, updatePortfolioSuggestion } from '@/lib/db/repositories/calendar';
import { ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

const ApproveSchema = z.object({
  week: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
});

/**
 * POST /api/portfolio/approve
 *
 * Phase 3 (brief §33/§39) — approve or reject the weekly portfolio plan.
 * Approving marks all suggestions for the week with the decision.
 */
export async function POST(request: Request) {
  const parsed = await parseJsonBody(request, ApproveSchema);
  if (parsed.error) return parsed.error;

  const suggestions = listPortfolioSuggestions(parsed.data.week);
  if (suggestions.length === 0) {
    return ok({ week: parsed.data.week, updated: 0, message: 'No suggestions for this week' });
  }

  let updated = 0;
  for (const s of suggestions) {
    if (updatePortfolioSuggestion(s.id, parsed.data.decision)) updated += 1;
  }

  return ok({ week: parsed.data.week, decision: parsed.data.decision, updated });
}
