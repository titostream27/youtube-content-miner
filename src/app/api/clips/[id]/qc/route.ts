import { getClip } from '@/lib/db/repositories/clips';
import { badRequest, notFound, ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/clips/:id/qc
 *
 * Phase 2 (brief §39) — return the structured QC state of a clip:
 *   { qcStatus, qcScore, qcReport, renderStatus }
 * The report contains the renderer's structured checks when available.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  let report: unknown = null;
  if (clip.qcReport) {
    try {
      report = JSON.parse(clip.qcReport);
    } catch {
      report = clip.qcReport;
    }
  }

  return ok({
    clipId: clip.id,
    qcStatus: clip.qcStatus,
    qcScore: clip.qcScore,
    renderStatus: clip.renderStatus,
    boundaryStatus: clip.boundaryStatus,
    report,
  });
}
