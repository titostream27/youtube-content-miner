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
  // Phase 3 (brief §25): full rights metadata.
  evidence: z.string().optional(),
  attribution_template: z.string().optional(),
  allowed_platforms: z.array(z.string()).optional(),
  allowed_regions: z.array(z.string()).optional(),
  expiration: z.string().optional(),
  reviewed_by: z.string().optional(),
});

/**
 * POST /api/clips/:id/rights
 *
 * Phase 3 (Master Task Brief §25) — set reuse rights status + metadata.
 * A clip with rights_status 'unknown' (default) is blocked by the publish
 * gate. 'creative_commons' keeps attribution requirements.
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
    evidence: parsed.data.evidence ?? null,
    attributionTemplate: parsed.data.attribution_template ?? null,
    allowedPlatforms: parsed.data.allowed_platforms ?? [],
    allowedRegions: parsed.data.allowed_regions ?? [],
    expiration: parsed.data.expiration ?? null,
    reviewedBy: parsed.data.reviewed_by ?? null,
  });

  const updated = getClip(clipId);
  return ok({
    rightsStatus: updated?.rightsStatus ?? parsed.data.status,
    rightsNotes: updated?.rightsNotes ?? parsed.data.notes ?? null,
    rightsEvidence: updated?.rightsEvidence ?? parsed.data.evidence ?? null,
    rightsAttributionTemplate: updated?.rightsAttributionTemplate ?? parsed.data.attribution_template ?? null,
    rightsAllowedPlatforms: updated?.rightsAllowedPlatforms ?? parsed.data.allowed_platforms ?? [],
    rightsAllowedRegions: updated?.rightsAllowedRegions ?? parsed.data.allowed_regions ?? [],
    rightsExpiration: updated?.rightsExpiration ?? parsed.data.expiration ?? null,
    rightsReviewedBy: updated?.rightsReviewedBy ?? parsed.data.reviewed_by ?? null,
  });
}
