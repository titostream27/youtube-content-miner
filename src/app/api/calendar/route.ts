import { listCalendar } from '@/lib/db/repositories/calendar';
import { getClip } from '@/lib/db/repositories/clips';
import { ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/calendar?from=ISO&to=ISO
 *
 * Phase 3 (brief §35/§39) — content calendar with clip titles/status.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;

  const entries = listCalendar(from, to).map((e) => {
    const clip = getClip(e.clipId);
    return {
      ...e,
      clipTitle: clip?.title ?? null,
      publishUrl: clip?.publishUrl ?? null,
    };
  });

  return ok({ entries, count: entries.length });
}
