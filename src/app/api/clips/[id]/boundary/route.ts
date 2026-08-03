import { z } from 'zod';
import { getClip, updateClipBoundary } from '@/lib/db/repositories/clips';
import { addBoundaryFeedback } from '@/lib/db/repositories/feedback';
import { badRequest, notFound, ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BoundaryPatchSchema = z.object({
  start_sec: z.number().min(0),
  end_sec: z.number().min(0),
  reason: z.string().optional(),
});

/**
 * PATCH /api/clips/:id/boundary
 *
 * Phase 2 (Master Task Brief §22/§39) — manual boundary correction.
 * Updates the clip's start/end and persists the edit as feedback so the
 * AI can learn from human review.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const parsed = await parseJsonBody(request, BoundaryPatchSchema);
  if (parsed.error) return parsed.error;

  if (parsed.data.end_sec <= parsed.data.start_sec) {
    return badRequest('end_sec must be greater than start_sec');
  }

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  // Persist feedback BEFORE mutating so original boundaries are preserved.
  addBoundaryFeedback({
    clipId,
    originalStartSec: clip.startSec,
    originalEndSec: clip.endSec,
    newStartSec: parsed.data.start_sec,
    newEndSec: parsed.data.end_sec,
    reason: parsed.data.reason ?? 'manual boundary adjustment',
  });

  updateClipBoundary(clipId, {
    startSec: parsed.data.start_sec,
    endSec: parsed.data.end_sec,
    durationSec: Math.round((parsed.data.end_sec - parsed.data.start_sec) * 100) / 100,
    boundaryStatus: 'repaired',
    repairReason: parsed.data.reason ?? 'manual boundary adjustment',
  });

  const updated = getClip(clipId);
  return ok({
    clipId,
    startSec: updated?.startSec,
    endSec: updated?.endSec,
    durationSec: updated?.durationSec,
    boundaryStatus: updated?.boundaryStatus,
    message: 'Boundary updated; feedback recorded',
  });
}
