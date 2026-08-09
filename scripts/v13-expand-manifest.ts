/**
 * Brief V13 Phase C — Expansion manifest for the full 344-candidate pool.
 *
 * Builds a judge manifest covering EVERY candidate in the V12 lineage (the
 * preferred strategy §5 step 7: full consensus across all 344). The manifest
 * includes the previously-sampled 51 (already judged in V12R; the runner
 * reuses their persisted outputs via resume) and marks which candidates are
 * already covered.
 *
 * Usage:
 *   node --import tsx scripts/v13-expand-manifest.ts \
 *     --lineage docs/evidence/v12-lineage.jsonl \
 *     --prior evidence/v12r/consensus_labels.jsonl \
 *     --out evidence/v13/benchmark_manifest.json
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LineageRow } from '../src/lib/v12r/sampling';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main(): void {
  const lineagePath = arg('lineage') ?? 'docs/evidence/v12-lineage.jsonl';
  const priorPath = arg('prior') ?? 'evidence/v12r/consensus_labels.jsonl';
  const outPath = arg('out') ?? 'evidence/v13/benchmark_manifest.json';

  const rows: LineageRow[] = fs
    .readFileSync(path.resolve(lineagePath), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LineageRow)
    .filter((r) => r.candidate_id && r.episode_id);

  const prior = new Set<string>();
  if (fs.existsSync(path.resolve(priorPath))) {
    for (const line of fs.readFileSync(path.resolve(priorPath), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as { candidate_id?: string };
      if (rec.candidate_id) prior.add(rec.candidate_id);
    }
  }

  const manifest = {
    brief: 'Brief_V13_Production_Selector_Alignment_Silver_Pass_Recall.pdf',
    generated_at: new Date().toISOString(),
    strategy: 'full pool consensus (preferred): Judge A + B over all 344 lineage candidates, Judge C on disagreement',
    judge_independence_tier: 'Good+ (three model families, two provider endpoints)',
    candidates: rows.map((r) => ({
      candidate_id: r.candidate_id,
      episode_id: r.episode_id,
      window: {
        start_sec: r.final_start_sec ?? r.rough_start_sec ?? 0,
        end_sec: r.final_end_sec ?? r.rough_end_sec ?? 0,
      },
      rejection_stage: r.rejection_stage ?? null,
      kept: Boolean(r.kept),
      accepted: Boolean(r.accepted),
      prior_judged: prior.has(r.candidate_id!),
    })),
    counts: {
      total: rows.length,
      prior_judged: rows.filter((r) => prior.has(r.candidate_id!)).length,
      episodes: new Set(rows.map((r) => r.episode_id)).size,
    },
  };

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(
    JSON.stringify({
      wrote: outPath,
      total: manifest.counts.total,
      prior_judged: manifest.counts.prior_judged,
      episodes: manifest.counts.episodes,
    }),
  );
}

main();