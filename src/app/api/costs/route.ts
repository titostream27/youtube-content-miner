import { z } from 'zod';
import { addCostEntry, getCostSummary, listCostEntries } from '@/lib/db/repositories/cost-ledger';
import { ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

const CostSchema = z.object({
  run_id: z.number().int().optional(),
  clip_id: z.number().int().optional(),
  category: z.enum(['llm', 'youtube_quota', 'transcript_vendor', 'render', 'storage', 'publish_api', 'gpu_estimate']),
  cost_type: z.enum(['estimate', 'actual']).optional(),
  amount_usd: z.number().min(0),
  units: z.string().optional(),
  quantity: z.number().optional(),
  note: z.string().optional(),
});

/**
 * Phase 4 (Master Task Brief §37/§39):
 *   GET /api/costs            — summary + entries
 *   POST /api/costs           — add one ledger entry
 *   POST /api/costs/llm       — convenience: record LLM cost from token counts
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get('runId') ? Number.parseInt(url.searchParams.get('runId')!, 10) : undefined;
  return ok({
    summary: getCostSummary(),
    entries: listCostEntries(runId),
  });
}

export async function POST(request: Request) {
  const parsed = await parseJsonBody(request, CostSchema);
  if (parsed.error) return parsed.error;

  const entry = addCostEntry({
    runId: parsed.data.run_id,
    clipId: parsed.data.clip_id,
    category: parsed.data.category,
    costType: parsed.data.cost_type,
    amountUsd: parsed.data.amount_usd,
    units: parsed.data.units,
    quantity: parsed.data.quantity,
    note: parsed.data.note,
  });

  return ok({ entry });
}
