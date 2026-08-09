/**
 * Brief V13 Phase H/I — Attribution staircase for the silver-PASS cohort.
 * Replays each PASS candidate under a sequence of single/multi gate bypasses
 * so the "first death" attribution chain is explicit.
 *
 * Usage:
 *   DATABASE_PATH=... node --import tsx scripts/v13-attribution.ts
 *     --labels evidence/v13/consensus_labels_v13.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { traceCandidate, type StageName } from '../src/lib/v13r/trace';
import type { LineageRow } from '../src/lib/v12r/sampling';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BYPASS_SETS: { name: string; set: ReadonlySet<StageName> }[] = [
  { name: 'none', set: new Set() },
  { name: 'only05', set: new Set(['05_ENDING_CONFIDENCE']) },
  { name: 'only03', set: new Set(['03_START_GATE']) },
  { name: '03+05', set: new Set(['03_START_GATE', '05_ENDING_CONFIDENCE']) },
  { name: '03+05+12', set: new Set(['03_START_GATE', '05_ENDING_CONFIDENCE', '12_ACCEPTANCE_THRESHOLD']) },
];

function main(): void {
  const labelsPath = arg('labels') ?? 'evidence/v13/consensus_labels_v13.jsonl';
  const outPath = arg('out') ?? 'evidence/v13/attribution_staircase.jsonl';

  const labels = new Map<string, string>();
  for (const line of fs.readFileSync(path.resolve(labelsPath), 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { candidate_id?: string; label?: string };
    if (rec.candidate_id && rec.label) labels.set(rec.candidate_id, rec.label);
  }

  const rows: LineageRow[] = fs
    .readFileSync('docs/evidence/v12-lineage.jsonl', 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LineageRow)
    .filter((r) => r.candidate_id && labels.get(r.candidate_id!) === 'PASS');

  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const transcript = getTranscript(row.episode_id!);
    if (!transcript || transcript.cues.length === 0) continue;
    const line: Record<string, unknown> = { candidate_id: row.candidate_id, episode_id: row.episode_id, window: [row.final_start_sec ?? row.rough_start_sec, row.final_end_sec ?? row.rough_end_sec] };
    for (const { name, set: bypass } of BYPASS_SETS) {
      const t = traceCandidate(row, transcript, { overrides: { bypass } });
      line[name] = {
        first_death: t.first_death,
        accepted: t.final_accepted,
        score: t.final_score,
      };
    }
    out.push(line);
  }
  fs.writeFileSync(path.resolve(outPath), out.map((o) => JSON.stringify(o)).join('\n'), 'utf-8');
  console.log(JSON.stringify(out, null, 2));
}

main();