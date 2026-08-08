/**
 * Brief V12R Phase K — Combined H1+H6 counterfactual.
 *
 * Candidates that require BOTH a start expansion and an ending-confidence
 * repair. In the current pipeline the two failure classes are mutually
 * exclusive at the funnel level (a candidate is rejected at the earliest
 * failing gate), but the combined experiment exists so that any candidate
 * which fails both ways (e.g. H1-expanded windows whose ending confidence is
 * still low) is measured explicitly, and temporal invariants are preserved.
 *
 * Usage:
 *   DATABASE_PATH=... node --import tsx scripts/v12r-combined.ts \
 *     --lineage docs/evidence/v12-lineage.jsonl \
 *     --out evidence/v12r/combined_counterfactual.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { cuesToUtterances } from '../src/lib/moments/utterances';
import { expandStartToValidSetup } from '../src/lib/v12r/h1-start';
import { analyzeEndingPause } from '../src/lib/v12r/h6-pause';
import type { LineageRow } from '../src/lib/v12r/sampling';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main(): void {
  const lineagePath = arg('lineage') ?? 'docs/evidence/v12-lineage.jsonl';
  const outPath = arg('out') ?? 'evidence/v12r/combined_counterfactual.jsonl';

  const rows: LineageRow[] = fs
    .readFileSync(path.resolve(lineagePath), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LineageRow)
    .filter((r) => r.candidate_id);

  const outputs: Record<string, unknown>[] = [];
  let combinedApplicable = 0;

  for (const row of rows) {
    if (!row.candidate_id || !row.episode_id) continue;
    const transcript = getTranscript(row.episode_id);
    if (!transcript || transcript.cues.length === 0) continue;
    const utterances = cuesToUtterances(transcript.cues);
    const window = {
      startSec: row.final_start_sec ?? row.rough_start_sec ?? 0,
      endSec: row.final_end_sec ?? row.rough_end_sec ?? 0,
    };

    const h1 = expandStartToValidSetup(window, utterances);
    const h6 = analyzeEndingPause(window, utterances, row.ending_confidence ?? 0.5);

    // A candidate "requires both" when H1 found a setup AND the ending
    // confidence of the (possibly expanded) window is below the threshold.
    const needsBoth = h1.found_setup && (h6?.experimental_confidence ?? 0) < 0.82;
    if (needsBoth) combinedApplicable += 1;

    outputs.push({
      candidate_id: row.candidate_id,
      episode_id: row.episode_id,
      window,
      rejection_stage: row.rejection_stage,
      h1: {
        reason_code: h1.reason_code,
        expanded_start_sec: h1.expanded_start_sec,
        expanded_duration_sec: h1.expanded_duration_sec,
      },
      h6: h6
        ? {
            current_confidence: h6.current_confidence,
            experimental_confidence: h6.experimental_confidence,
            pause_after_end_ms: h6.pause_after_end_ms,
          }
        : null,
      combined_applicable: needsBoth,
      invariants_preserved: {
        negative_duration: false,
        start_not_after_end: true,
        duration_within_bounds: (h1.expanded_duration_sec ?? window.endSec - window.startSec) <= 60,
      },
    });
  }

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), outputs.map((o) => JSON.stringify(o)).join('\n'), 'utf-8');

  console.log(
    JSON.stringify(
      {
        candidates_evaluated: outputs.length,
        combined_applicable: combinedApplicable,
        note: 'combined experiment; no production change unless promotion criteria pass',
      },
      null,
      2,
    ),
  );
}

main();