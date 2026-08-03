import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 4 (Master Task Brief §37) — cost ledger.
 *
 * Tracks cost per run and per clip. `costType` separates ESTIMATE from ACTUAL
 * (the brief explicitly forbids mixing them without the distinguishing field).
 * LLM token costs are estimated from UsageLedger; render/GPU costs are
 * estimates; publish API calls are actuals when the platform bills them.
 */

export type CostCategory =
  | 'llm'
  | 'youtube_quota'
  | 'transcript_vendor'
  | 'render'
  | 'storage'
  | 'publish_api'
  | 'gpu_estimate';

export type CostType = 'estimate' | 'actual';

export interface CostEntryInput {
  runId?: number | null;
  clipId?: number | null;
  category: CostCategory;
  costType?: CostType;
  amountUsd: number;
  units?: string;
  quantity?: number;
  note?: string;
}

export interface CostEntry extends CostEntryInput {
  id: number;
  costType: CostType;
  createdAt: string;
}

interface Row {
  id: number;
  run_id: number | null;
  clip_id: number | null;
  category: string;
  cost_type: string;
  amount_usd: number;
  units: string | null;
  quantity: number | null;
  note: string | null;
  created_at: string;
}

function mapRow(r: Row): CostEntry {
  return {
    id: r.id,
    runId: r.run_id,
    clipId: r.clip_id,
    category: r.category as CostCategory,
    costType: r.cost_type as CostType,
    amountUsd: r.amount_usd,
    units: r.units ?? undefined,
    quantity: r.quantity ?? undefined,
    note: r.note ?? undefined,
    createdAt: r.created_at,
  };
}

export function addCostEntry(input: CostEntryInput): CostEntry {
  getDb()
    .prepare(
      `INSERT INTO cost_ledger (run_id, clip_id, category, cost_type, amount_usd, units, quantity, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId ?? null,
      input.clipId ?? null,
      input.category,
      input.costType ?? 'estimate',
      input.amountUsd,
      input.units ?? null,
      input.quantity ?? null,
      input.note ?? null,
      nowIso(),
    );
  const row = getDb().prepare('SELECT * FROM cost_ledger WHERE id = last_insert_rowid()').get() as Row;
  return mapRow(row);
}

export interface CostSummary {
  totalEstimateUsd: number;
  totalActualUsd: number;
  byCategory: Partial<Record<CostCategory, { estimateUsd: number; actualUsd: number; entries: number }>>;
  perApprovedClip: number;
  approvedClipCount: number;
}

export function getCostSummary(): CostSummary {
  const rows = getDb().prepare('SELECT * FROM cost_ledger ORDER BY id').all() as Row[];
  const byCategory: CostSummary['byCategory'] = {};
  let totalEstimateUsd = 0;
  let totalActualUsd = 0;

  for (const r of rows) {
    const bucket = byCategory[r.category as CostCategory] ?? { estimateUsd: 0, actualUsd: 0, entries: 0 };
    if (r.cost_type === 'actual') {
      bucket.actualUsd += r.amount_usd;
      totalActualUsd += r.amount_usd;
    } else {
      bucket.estimateUsd += r.amount_usd;
      totalEstimateUsd += r.amount_usd;
    }
    bucket.entries += 1;
    byCategory[r.category as CostCategory] = bucket;
  }

  const approved = getDb()
    .prepare("SELECT COUNT(*) AS c FROM clips WHERE tier != 'archive'")
    .get() as { c: number };
  const approvedClipCount = approved.c;

  return {
    totalEstimateUsd: Math.round(totalEstimateUsd * 1000) / 1000,
    totalActualUsd: Math.round(totalActualUsd * 1000) / 1000,
    byCategory,
    perApprovedClip: approvedClipCount > 0 ? Math.round((totalEstimateUsd / approvedClipCount) * 1000) / 1000 : 0,
    approvedClipCount,
  };
}

export function listCostEntries(runId?: number): CostEntry[] {
  const rows = runId
    ? (getDb().prepare('SELECT * FROM cost_ledger WHERE run_id = ? ORDER BY id').all(runId) as Row[])
    : (getDb().prepare('SELECT * FROM cost_ledger ORDER BY id DESC LIMIT 500').all() as Row[]);
  return rows.map(mapRow);
}

/** Approximate LLM USD cost from token counts (DeepSeek-ish pricing). */
export function estimateLlmCost(inputTokens: number, outputTokens: number): number {
  const inputRate = 0.27 / 1_000_000; // $ per input token
  const outputRate = 1.10 / 1_000_000; // $ per output token
  return Math.round((inputTokens * inputRate + outputTokens * outputRate) * 100_000) / 100_000;
}
