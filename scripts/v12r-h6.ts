/**
 * Brief V12R Phase I — H6 pause-aware ending confidence counterfactual.
 *
 * For every sampled ENDING_CONFIDENCE reject (plus any candidate with an
 * ending_confidence), compute the experimental pause-aware confidence from
 * the frozen-corpus utterances and compare the experimental decision against
 * the silver-gold consensus label. This NEVER touches production code.
 *
 * Usage:
 *   DATABASE_PATH=... node --import tsx scripts/v12r-h6.ts \
 *     --lineage docs/evidence/v12-lineage.jsonl \
 *     --consensus evidence/v12r/consensus_labels.jsonl \
 *     --out evidence/v12r/h6_counterfactual.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { cuesToUtterances } from '../src/lib/moments/utterances';
import { analyzeEndingPause } from '../src/lib/v12r/h6-pause';
import type { LineageRow } from '../src/lib/v12r/sampling';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

interface ConsensusRow {
  candidate_id: string;
  label: string;
}

function main(): void {
  const lineagePath = arg('lineage') ?? 'docs/evidence/v12-lineage.jsonl';
  const consensusPath = arg('consensus') ?? 'evidence/v12r/consensus_labels.jsonl';
  const outPath = arg('out') ?? 'evidence/v12r/h6_counterfactual.jsonl';

  const rows: LineageRow[] = fs
    .readFileSync(path.resolve(lineagePath), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LineageRow)
    .filter((r) => r.candidate_id);

  const consensus = new Map<string, ConsensusRow>();
  if (fs.existsSync(path.resolve(consensusPath))) {
    for (const line of fs.readFileSync(path.resolve(consensusPath), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as ConsensusRow;
      if (rec.candidate_id) consensus.set(rec.candidate_id, rec);
    }
  }

  const outputs: Record<string, unknown>[] = [];
  let coveringCount = 0;
  let recovered = 0;
  let promotedNegatives = 0;

  for (const row of rows) {
    if (!row.candidate_id || !row.episode_id) continue;
    if (row.rejection_stage !== 'ENDING_CONFIDENCE' && row.ending_confidence === null) continue;
    const transcript = getTranscript(row.episode_id);
    if (!transcript || transcript.cues.length === 0) continue;
    const utterances = cuesToUtterances(transcript.cues);

    const window = {
      startSec: row.final_start_sec ?? row.rough_start_sec ?? 0,
      endSec: row.final_end_sec ?? row.rough_end_sec ?? 0,
    };
    const features = analyzeEndingPause(window, utterances, row.ending_confidence ?? 0.5);
    if (!features) continue;

    const silver = consensus.get(row.candidate_id)?.label ?? null;
    const rec = {
      candidate_id: row.candidate_id,
      episode_id: row.episode_id,
      window,
      current_confidence: features.current_confidence,
      punctuation_feature: features.punctuation_feature,
      pause_after_end_ms: features.pause_after_end_ms,
      speaker_change_after_end: features.speaker_change_after_end,
      semantic_closure_features: features.semantic_closure_features,
      next_topic_features: features.next_topic_features,
      experimental_confidence: features.experimental_confidence,
      current_decision: features.current_decision,
      experimental_decision: features.experimental_decision,
      silver_gold_label: silver,
    };
    outputs.push(rec);
    coveringCount += 1;
    if (features.experimental_decision === 'ACCEPT' && features.current_decision === 'REJECT') {
      recovered += 1;
      if (silver === 'FAIL') promotedNegatives += 1;
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), outputs.map((o) => JSON.stringify(o)).join('\n'), 'utf-8');

  console.log(
    JSON.stringify(
      {
        analyzed: coveringCount,
        experimental_recoveries: recovered,
        experimental_false_promotions: promotedNegatives,
        note: 'experimental only; production threshold unchanged',
      },
      null,
      2,
    ),
  );
}

main();