/**
 * Brief V12R Phase J — H1 valid-setup start expansion counterfactual.
 *
 * For every sampled START_GATE reject, run the bounded backward setup search
 * and record the reason code. Optionally re-judge expanded candidates through
 * the A/B/C silver consensus (--judge).
 *
 * Usage:
 *   DATABASE_PATH=... node --import tsx scripts/v12r-h1.ts \
 *     --sample evidence/v12r/sample_manifest.json \
 *     --out evidence/v12r/h1_counterfactual.jsonl \
 *     [--judge]
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { cuesToUtterances } from '../src/lib/moments/utterances';
import { expandStartToValidSetup } from '../src/lib/v12r/h1-start';
import { buildJudgeInput } from '../src/lib/v12r/judge-input';
import { callJudge } from '../src/lib/v12r/judge-runner';
import { decideConsensus } from '../src/lib/v12r/consensus';
import type { SampleManifest } from '../src/lib/v12r/sampling';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const samplePath = arg('sample') ?? 'evidence/v12r/sample_manifest.json';
  const outPath = arg('out') ?? 'evidence/v12r/h1_counterfactual.jsonl';
  const doJudge = process.argv.includes('--judge');

  const manifest: SampleManifest = JSON.parse(
    fs.readFileSync(path.resolve(samplePath), 'utf-8'),
  ) as SampleManifest;
  const startGateEntries = manifest.sample.filter((e) => e.stratum === 'start_gate' || e.stratum === 'top_ranked');

  const outputs: Record<string, unknown>[] = [];
  let expanded = 0;
  let rejected = 0;

  for (const entry of startGateEntries) {
    const transcript = getTranscript(entry.episode_id);
    if (!transcript || transcript.cues.length === 0) continue;
    const utterances = cuesToUtterances(transcript.cues);
    const result = expandStartToValidSetup(
      { startSec: entry.window.start_sec, endSec: entry.window.end_sec },
      utterances,
    );

    let rejudge: Record<string, unknown> | null = null;
    if (doJudge && result.found_setup && result.expanded_start_sec !== null) {
      const contract = buildJudgeInput(
        transcript,
        { startSec: result.expanded_start_sec, endSec: result.expanded_end_sec ?? entry.window.end_sec },
        `${entry.candidate_id}.h1`,
      );
      const a = await callJudge('A', contract);
      const b = await callJudge('B', contract);
      const c = a.status === 'ok' && b.status === 'ok' && a.output?.publishable !== b.output?.publishable
        ? await callJudge('C', contract)
        : null;
      const consensus = decideConsensus(a, b, c);
      rejudge = { label: consensus.label, rule: consensus.rule, judge_c_invoked: consensus.judge_c_invoked };
    }

    const rec = {
      candidate_id: entry.candidate_id,
      episode_id: entry.episode_id,
      original_window: entry.window,
      stratum: entry.stratum,
      ...result,
      rejudged: rejudge,
    };
    outputs.push(rec);
    if (result.found_setup) expanded += 1;
    else rejected += 1;
  }

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), outputs.map((o) => JSON.stringify(o)).join('\n'), 'utf-8');

  console.log(
    JSON.stringify(
      {
        analyzed: outputs.length,
        expansions_found: expanded,
        rejections: rejected,
        reason_codes: reasonCounts(outputs),
        rerun_note: doJudge ? 'expanded candidates were re-judged through silver consensus' : 'judge pass skipped (--judge)',
      },
      null,
      2,
    ),
  );
}

function reasonCounts(rows: Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const code = r.reason_code as string;
    out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

void main();