import { z } from 'zod';
import { addCostEntry, estimateLlmCost } from '@/lib/db/repositories/cost-ledger';
import { ok, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

const LlmCostSchema = z.object({
  run_id: z.number().int().optional(),
  clip_id: z.number().int().optional(),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  note: z.string().optional(),
});

/**
 * POST /api/costs/llm
 *
 * Phase 4 (brief §37) — record an LLM cost estimate from token counts
 * (computed with estimateLlmCost, DeepSeek-style pricing).
 */
export async function POST(request: Request) {
  const parsed = await parseJsonBody(request, LlmCostSchema);
  if (parsed.error) return parsed.error;

  const amountUsd = estimateLlmCost(parsed.data.input_tokens, parsed.data.output_tokens);
  const entry = addCostEntry({
    runId: parsed.data.run_id,
    clipId: parsed.data.clip_id,
    category: 'llm',
    costType: 'estimate',
    amountUsd,
    units: 'tokens',
    quantity: parsed.data.input_tokens + parsed.data.output_tokens,
    note: parsed.data.note ?? `${parsed.data.input_tokens} in / ${parsed.data.output_tokens} out tokens`,
  });

  return ok({ entry, amountUsd });
}
