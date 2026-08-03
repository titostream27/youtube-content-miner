import { z } from 'zod';
import { getClip } from '@/lib/db/repositories/clips';
import { selectVariant, getVariant } from '@/lib/db/repositories/variants';
import { badRequest, notFound, ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SelectSchema = z.object({
  variant_key: z.enum(['hook_a', 'hook_b', 'hook_c']),
});

/**
 * POST /api/clips/:id/variants/select
 *
 * Phase 4 (brief §36) — select one variant as active (rejects the others).
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const parsed = await parseJsonBody(request, SelectSchema);
  if (parsed.error) return parsed.error;

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  const variant = getVariant(clipId, parsed.data.variant_key);
  if (!variant) return badRequest(`Variant ${parsed.data.variant_key} not generated yet. POST /api/clips/:id/variants first.`);

  selectVariant(clipId, parsed.data.variant_key);

  return ok({
    clipId,
    selected: parsed.data.variant_key,
    hook: variant.hook,
    title: variant.title,
  });
}
