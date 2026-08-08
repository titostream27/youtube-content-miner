/**
 * Brief V12R Phase B — Deterministic stratified sampling from the V12 lineage.
 *
 * The 344-candidate lineage is the source pool. We build a bounded sample
 * (default 60) that covers every major failure class and likely positives,
 * using a FIXED seed so the sample is reproducible (AJ-19).
 */
export interface LineageRow {
  candidate_id?: string;
  episode_id?: string;
  rough_start_sec?: number;
  rough_end_sec?: number;
  rough_duration_sec?: number;
  final_start_sec?: number | null;
  final_end_sec?: number | null;
  kept?: boolean;
  accepted?: boolean;
  rejection_stage?: string | null;
  rejection_reason?: string | null;
  ending_confidence?: number | null;
  ending_type?: string | null;
  rank?: number | null;
  final_score?: number | null;
  start_complete?: boolean | null;
  contamination?: number | null;
  [key: string]: unknown;
}

export interface SampleEntry {
  candidate_id: string;
  episode_id: string;
  window: { start_sec: number; end_sec: number };
  rejection_stage: string | null;
  kept: boolean;
  accepted: boolean;
  ending_confidence: number | null;
  ending_type: string | null;
  rank: number | null;
  stratum: string;
}

export interface SampleManifest {
  seed: number;
  target_size: number;
  source_pool_size: number;
  sample: SampleEntry[];
  rationale: string[];
  strat_counts: Record<string, number>;
}

/** mulberry32 — small deterministic PRNG for reproducible sampling (AJ-19). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isEndingConfidenceReject(row: LineageRow): boolean {
  return !row.kept && row.rejection_stage === 'ENDING_CONFIDENCE';
}

export function isStartGateReject(row: LineageRow): boolean {
  return !row.kept && (row.rejection_stage === 'FINALIZE_START_GATE' || row.rejection_stage === 'START_GATE');
}

export function isEndingCompleteReject(row: LineageRow): boolean {
  return !row.kept && row.rejection_stage === 'ENDING_COMPLETE';
}

function entryOf(row: LineageRow, stratum: string): SampleEntry | null {
  const id = row.candidate_id;
  const ep = row.episode_id;
  if (!id || !ep) return null;
  return {
    candidate_id: id,
    episode_id: ep,
    window: {
      start_sec: row.final_start_sec ?? row.rough_start_sec ?? 0,
      end_sec: row.final_end_sec ?? row.rough_end_sec ?? 0,
    },
    rejection_stage: row.rejection_stage ?? null,
    kept: Boolean(row.kept),
    accepted: Boolean(row.accepted),
    ending_confidence: endingConfidenceOf(row),
    ending_type: row.ending_type ?? null,
    rank: row.rank ?? null,
    stratum,
  };
}

/** Parse "ending confidence 0.78 < 0.80" style reasons for the H6 cluster. */
export function endingConfidenceOf(row: LineageRow): number | null {
  if (typeof row.ending_confidence === 'number') return row.ending_confidence;
  const reason = String(row.rejection_reason ?? '');
  const match = /ending confidence\s+([0-9.]+)/i.exec(reason);
  return match ? Number.parseFloat(match[1]!) : null;
}

/** Preference for per-episode fill: accepted > kept > H6 cluster > other. */
function preferenceScore(row: LineageRow): number {
  if (row.accepted) return 4;
  if (row.kept) return 3;
  if (isEndingConfidenceReject(row) && endingConfidenceOf(row) !== null) return 2;
  return 1;
}

/**
 * Build the stratified sample.
 *
 * Strata (in priority order):
 *   accepted, kept_non_accepted, contamination,
 *   ending_confidence_cluster (0.78-0.82), ending_confidence_other,
 *   start_gate, ending_complete, top_ranked, random_negatives.
 * Each stratum is capped so one dominant failure class cannot monopolize
 * the sample, keeping the major classes all represented (brief Phase B).
 */
export function buildStratifiedSample(
  rows: LineageRow[],
  opts: { targetSize?: number; seed?: number } = {},
): SampleManifest {
  const target = opts.targetSize ?? 60;
  const seed = opts.seed ?? 20260808;
  const rand = mulberry32(seed);
  const seen = new Set<string>();
  const sample: SampleEntry[] = [];
  const stratumCounts = new Map<string, number>();

  const CAPS: Record<string, number> = {
    accepted: 99,
    kept_non_accepted: 99,
    contamination: 99,
    'ending_confidence_0.78_0.82': 16,
    ending_confidence_other: 10,
    start_gate: 14,
    ending_complete: 8,
    top_ranked: 8,
    random_negative: 6,
    per_episode: 99,
  };

  const add = (row: LineageRow, stratum: string): void => {
    const entry = entryOf(row, stratum);
    if (!entry || seen.has(entry.candidate_id)) return;
    if (sample.length >= target) return;
    if ((stratumCounts.get(stratum) ?? 0) >= (CAPS[stratum] ?? 99)) return;
    seen.add(entry.candidate_id);
    stratumCounts.set(stratum, (stratumCounts.get(stratum) ?? 0) + 1);
    sample.push(entry);
  };

  // 1. All accepted production candidates.
  for (const row of rows) if (row.accepted) add(row, 'accepted');

  // 2. Kept but not accepted.
  for (const row of rows) if (row.kept && !row.accepted) add(row, 'kept_non_accepted');

  // 3. The known contamination case.
  for (const row of rows) {
    if (!row.kept && row.rejection_stage === 'NEXT_TOPIC_CONTAMINATION') add(row, 'contamination');
  }

  // 4. ENDING_CONFIDENCE rejects clustered at 0.78-0.82 (the H6 zone).
  const inH6Zone = (r: LineageRow): boolean => {
    const c = endingConfidenceOf(r);
    return c !== null && c >= 0.78 && c <= 0.82;
  };
  const ecCluster = rows
    .filter((r) => isEndingConfidenceReject(r) && inH6Zone(r))
    .sort((a, b) => (a.episode_id ?? '').localeCompare(b.episode_id ?? ''));
  for (const row of ecCluster) add(row, 'ending_confidence_0.78_0.82');

  // 5. Other ENDING_CONFIDENCE rejects.
  const ecOther = rows
    .filter((r) => isEndingConfidenceReject(r) && !inH6Zone(r))
    .sort((a, b) => (a.episode_id ?? '').localeCompare(b.episode_id ?? ''));
  for (const row of ecOther) add(row, 'ending_confidence_other');

  // 6. START_GATE rejects (H1 zone).
  const sg = rows
    .filter((r) => isStartGateReject(r))
    .sort((a, b) => (a.episode_id ?? '').localeCompare(b.episode_id ?? ''));
  for (const row of sg) add(row, 'start_gate');

  // 7. ENDING_COMPLETE rejects.
  const ecp = rows
    .filter((r) => isEndingCompleteReject(r))
    .sort((a, b) => (a.episode_id ?? '').localeCompare(b.episode_id ?? ''));
  for (const row of ecp) add(row, 'ending_complete');

  // 8. Top-ranked candidates per episode (rank 1..5), unless already added.
  const topRanked = rows
    .filter((r) => r.rank !== null && r.rank !== undefined && r.rank >= 1 && r.rank <= 5)
    .sort((a, b) => (a.episode_id ?? '').localeCompare(b.episode_id ?? '') || (a.rank ?? 0) - (b.rank ?? 0));
  for (const row of topRanked) add(row, 'top_ranked');

  // 9. Seeded random negatives: low-ranked / scoring-rejected / min-duration.
  const negativePool = rows.filter(
    (r) =>
      !r.kept &&
      (r.rejection_stage === 'SCORING' || r.rejection_stage === 'MIN_DURATION' || r.rejection_stage === 'OTHER' || r.rank === null),
  );
  const shuffled = [...negativePool].sort(() => rand() - 0.5);
  for (const row of shuffled) add(row, 'random_negative');

  // 10. Per-episode coverage: every frozen episode must be represented
  // (brief Phase B: "minimum 40 with all 10 episodes ... represented").
  const coveredEpisodes = new Set(sample.map((e) => e.episode_id));
  const episodeOrder = [...new Set(rows.map((r) => r.episode_id ?? ''))].sort();
  for (const ep of episodeOrder) {
    if (coveredEpisodes.has(ep)) continue;
    const pool = rows
      .filter((r) => r.episode_id === ep && r.candidate_id && !seen.has(r.candidate_id))
      .sort((a, b) => preferenceScore(b) - preferenceScore(a));
    let addedAny = false;
    for (const row of pool) {
      const before = sample.length;
      add(row, 'per_episode');
      if (sample.length > before) {
        addedAny = true;
        break;
      }
    }
    if (addedAny) coveredEpisodes.add(ep);
  }

  const stratCounts: Record<string, number> = {};
  for (const entry of sample) stratCounts[entry.stratum] = (stratCounts[entry.stratum] ?? 0) + 1;

  return {
    seed,
    target_size: target,
    source_pool_size: rows.length,
    sample,
    rationale: [
      'Strata priority: accepted, kept_non_accepted, contamination, ending_confidence_0.78_0.82, ending_confidence_other, start_gate, ending_complete, top_ranked, random_negative.',
      'Deterministic PRNG (mulberry32) with fixed seed; ordering within strata is stable across reruns.',
      `Ending-confidence cluster 0.78-0.82 is the H6 zone; start_gate is the H1 zone.`,
    ],
    strat_counts: stratCounts,
  };
}