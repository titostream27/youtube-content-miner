import { z } from 'zod';
import { getClip, updateClipSchedule } from '@/lib/db/repositories/clips';
import { scheduleClip, getCalendarEntryByClip } from '@/lib/db/repositories/calendar';
import { badRequest, notFound, ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ScheduleSchema = z.object({
  scheduled_at: z.string().regex(/[+-]\d{2}:\d{2}$/, 'timestamp must include explicit timezone offset (e.g. -04:00)'),
  target_market: z.string().min(1),
  slot_label: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * POST /api/clips/:id/schedule
 *
 * Phase 3 (brief §35/§39) — schedule a clip for publication. Requires the
 * publish gates (rights approved, QC passed, render done) and an explicit
 * timezone in the timestamp.
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const parsed = await parseJsonBody(request, ScheduleSchema);
  if (parsed.error) return parsed.error;

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  // Gates: scheduling a clip that cannot be published is meaningless.
  const blockedRights = new Set(['unknown', 'blocked', 'editorial_review_required']);
  if (!clip.rightsStatus || blockedRights.has(clip.rightsStatus)) {
    return badRequest(`Cannot schedule: rights status '${clip.rightsStatus ?? 'unknown'}'.`);
  }
  if (clip.qcStatus !== 'passed') {
    return badRequest(`Cannot schedule: QC ${clip.qcStatus ?? 'pending'}.`);
  }
  if (clip.renderStatus !== 'done' || !clip.renderPath) {
    return badRequest('Cannot schedule: clip not rendered.');
  }

  const entry = scheduleClip({
    clipId,
    scheduledAt: parsed.data.scheduled_at,
    targetMarket: parsed.data.target_market,
    slotLabel: parsed.data.slot_label,
    reason: parsed.data.reason,
  });
  updateClipSchedule(clipId, {
    scheduledAt: parsed.data.scheduled_at,
    targetMarket: parsed.data.target_market,
  });

  return ok({
    calendarEntry: entry,
    clip: { scheduledAt: parsed.data.scheduled_at, targetMarket: parsed.data.target_market },
  });
}

/**
 * GET /api/clips/:id/schedule — return the clip's calendar entry.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  const entry = getCalendarEntryByClip(clipId);
  return ok({ scheduled: entry !== null, entry });
}
