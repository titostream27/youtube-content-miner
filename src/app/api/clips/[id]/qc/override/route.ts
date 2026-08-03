import { z } from 'zod';
import { getClip, updateClipQc } from '@/lib/db/repositories/clips';
import { badRequest, notFound, ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const QcSchema = z.object({
  status: z.enum(['passed', 'warning', 'failed']),
  score: z.number().min(0).max(100).optional(),
  note: z.string().optional(),
});

/**
 * POST /api/clips/:id/qc/override
 *
 * Phase 2 (brief §39) — manually override the QC status of a clip. Used when
 * a human reviewed the artifact and disagrees with the automated gate.
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const parsed = await parseJsonBody(request, QcSchema);
  if (parsed.error) return parsed.error;

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  updateClipQc(clipId, {
    status: parsed.data.status,
    score: parsed.data.score ?? null,
    note: parsed.data.note ?? null,
  });

  const updated = getClip(clipId);
  return ok({
    qcStatus: updated?.qcStatus ?? parsed.data.status,
    qcScore: updated?.qcScore ?? parsed.data.score ?? null,
  });
}
