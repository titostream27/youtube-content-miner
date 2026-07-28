import {
  getClip,
  recordClipFeedback,
  updateClipStatus,
} from '@/lib/db/repositories/clips';
import { badRequest, notFound, ok, parseJsonBody, serverError } from '@/lib/api/http';
import { clipUpdateSchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);

  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  try {
    const clip = getClip(clipId);
    return clip ? ok({ clip }) : notFound('Clip not found');
  } catch (error) {
    return serverError(error);
  }
}

/**
 * PATCH /api/clips/:id
 *
 * Updates the editor workflow status and optionally records a verdict.
 *
 * The verdict is the point: `clip_feedback` accumulates the labelled dataset the
 * PRD identifies as the long-term moat. Every approve and reject is a training
 * example for a future re-ranker that learns this creator's audience rather than
 * relying on a general-purpose model's taste.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);

  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const { data, error } = await parseJsonBody(request, clipUpdateSchema);
  if (error) return error;

  if (!data.status && !data.feedback) {
    return badRequest('Provide at least one of "status" or "feedback"');
  }

  try {
    if (!getClip(clipId)) return notFound('Clip not found');

    if (data.status) {
      updateClipStatus(clipId, data.status);
    }

    if (data.feedback) {
      recordClipFeedback({
        clipId,
        verdict: data.feedback.verdict,
        note: data.feedback.note ?? null,
      });
    }

    return ok({ clip: getClip(clipId) });
  } catch (error) {
    return serverError(error);
  }
}
