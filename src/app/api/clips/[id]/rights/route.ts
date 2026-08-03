import { z } from 'zod';
import { getClip, updateClipRights } from '@/lib/db/repositories/clips';
import { badRequest, notFound, ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const RightsSchema = z.object({
  status: z.enum([
    'owned',
    'explicit_permission',
    'official_clipping_program',
    'creative_commons',
    'editorial_review_required',
    'blocked',
  ]),
  notes: z.string().optional(),
});

/**
 * POST /api/clips/:id/rights
 *
 * Phase 3 (Master Task Brief §25) — set reuse rights status. A clip with
 * rights_status 'unknown' (default) is blocked by the publish gate.
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const parsed = await parseJsonBody(request, RightsSchema);
  if (parsed.error) return parsed.error;

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  updateClipRights(clipId, {
    status: parsed.data.status,
    notes: parsed.data.notes ?? null,
  });

  const updated = getClip(clipId);
  return ok({
    rightsStatus: updated?.rightsStatus ?? parsed.data.status,
    rightsNotes: updated?.rightsNotes ?? parsed.data.notes ?? null,
  });
}
