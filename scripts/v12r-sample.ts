/**
 * Brief V12R Phase B — Build the deterministic stratified sample manifest.
 *
 * Usage:
 *   node --import tsx scripts/v12r-sample.ts \
 *     --lineage docs/evidence/v12-lineage.jsonl \
 *     --out evidence/v12r/sample_manifest.json \
 *     [--target 60] [--seed 20260808]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildStratifiedSample, type LineageRow } from '../src/lib/v12r/sampling';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main(): void {
  const lineagePath = arg('lineage') ?? 'docs/evidence/v12-lineage.jsonl';
  const outPath = arg('out') ?? 'evidence/v12r/sample_manifest.json';
  const target = Number.parseInt(arg('target') ?? '60', 10);
  const seed = Number.parseInt(arg('seed') ?? '20260808', 10);

  const raw = fs.readFileSync(path.resolve(lineagePath), 'utf-8');
  const rows: LineageRow[] = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LineageRow)
    .filter((r) => r.candidate_id);

  const manifest = buildStratifiedSample(rows, { targetSize: target, seed });
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(manifest, null, 2), 'utf-8');

  console.log(`sample: ${manifest.sample.length}/${target} candidates from pool ${rows.length}`);
  console.log(JSON.stringify(manifest.strat_counts, null, 2));
  const eps = new Set(manifest.sample.map((e) => e.episode_id));
  console.log(`episodes covered: ${eps.size}/10`);
}

main();