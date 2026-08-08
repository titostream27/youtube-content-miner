/**
 * Brief V12R Phase H — Automated silver-gold benchmark run.
 *
 * Reads the sample manifest, builds judge input contracts from the frozen
 * corpus transcripts (DATABASE_PATH), calls Judge A + B for every candidate,
 * invokes Judge C on disagreement, applies deterministic consensus, and
 * persists raw judge outputs + consensus labels + benchmark metrics.
 *
 * Usage:
 *   DATABASE_PATH=... V12R_JUDGE_* ... node --import tsx scripts/v12r-judge-run.ts \
 *     --sample evidence/v12r/sample_manifest.json \
 *     --out-dir evidence/v12r \
 *     [--limit N] [--episode <id>] [--skip-a|--skip-b|--skip-c]
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { buildJudgeInput } from '../src/lib/v12r/judge-input';
import { callJudge } from '../src/lib/v12r/judge-runner';
import { decideConsensus, needsJudgeC } from '../src/lib/v12r/consensus';
import type { JudgeCall } from '../src/lib/v12r/judge-types';
import type { SampleManifest } from '../src/lib/v12r/sampling';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface BenchmarkResult {
  candidate_id: string;
  episode_id: string;
  window: { start_sec: number; end_sec: number };
  judges: { A: JudgeCall | null; B: JudgeCall | null; C: JudgeCall | null };
  consensus: ReturnType<typeof decideConsensus>;
}

async function main(): Promise<void> {
  const samplePath = arg('sample') ?? 'evidence/v12r/sample_manifest.json';
  const outDir = arg('out-dir') ?? 'evidence/v12r';
  const limit = Number.parseInt(arg('limit') ?? '0', 10);
  const episodeFilter = arg('episode');
  const skipA = hasFlag('skip-a');
  const skipB = hasFlag('skip-b');
  const skipC = hasFlag('skip-c');

  const manifest: SampleManifest = JSON.parse(
    fs.readFileSync(path.resolve(samplePath), 'utf-8'),
  ) as SampleManifest;

  let entries = manifest.sample;
  if (episodeFilter) entries = entries.filter((e) => e.episode_id === episodeFilter);
  if (limit > 0) entries = entries.slice(0, limit);

  const judgeOutputPath = path.join(outDir, 'judge_outputs.jsonl');
  const consensusPath = path.join(outDir, 'consensus_labels.jsonl');
  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  fs.writeFileSync(path.resolve(judgeOutputPath), '', 'utf-8');
  fs.writeFileSync(path.resolve(consensusPath), '', 'utf-8');

  const results: BenchmarkResult[] = [];
  let done = 0;

  for (const entry of entries) {
    const transcript = getTranscript(entry.episode_id);
    if (!transcript || transcript.cues.length === 0) {
      const failed = {
        candidate_id: entry.candidate_id,
        episode_id: entry.episode_id,
        window: entry.window,
        error: 'no cached transcript',
      };
      fs.appendFileSync(path.resolve(consensusPath), `${JSON.stringify(failed)}\n`, 'utf-8');
      done += 1;
      console.warn(`[v12r] skip ${entry.candidate_id}: no transcript`);
      continue;
    }

    const contract = buildJudgeInput(
      transcript,
      { startSec: entry.window.start_sec, endSec: entry.window.end_sec },
      entry.candidate_id,
    );
    const judgeA = skipA ? null : await callJudge('A', contract);
    const judgeB = skipB ? null : await callJudge('B', contract);

    let judgeC: JudgeCall | null = null;
    if (!skipC && judgeA && judgeB && needsJudgeC(judgeA, judgeB)) {
      judgeC = await callJudge('C', contract);
    }

    const consensus = decideConsensus(
      judgeA ?? failedCall('A'),
      judgeB ?? failedCall('B'),
      judgeC,
    );

    for (const j of [judgeA, judgeB, judgeC]) {
      if (j) {
        const row = {
          candidate_id: entry.candidate_id,
          episode_id: entry.episode_id,
          window: entry.window,
          ...j,
        };
        fs.appendFileSync(path.resolve(judgeOutputPath), `${JSON.stringify(row)}\n`, 'utf-8');
      }
    }

    const result: BenchmarkResult = {
      candidate_id: entry.candidate_id,
      episode_id: entry.episode_id,
      window: entry.window,
      judges: { A: judgeA, B: judgeB, C: judgeC },
      consensus,
    };
    results.push(result);
    fs.appendFileSync(
      path.resolve(consensusPath),
      `${JSON.stringify({ candidate_id: result.candidate_id, episode_id: result.episode_id, window: result.window, label: consensus.label, rule: consensus.rule, judge_c_invoked: consensus.judge_c_invoked, reason: consensus.reason, votes: consensus.votes })}\n`,
      'utf-8',
    );

    done += 1;
    console.warn(`[v12r] ${done}/${entries.length} ${entry.candidate_id} -> ${consensus.label} (${consensus.rule})`);
  }

  // Benchmark metrics (brief §11 + §23).
  const ok = results.filter((r) => r.consensus.label === 'PASS').length;
  const review = results.filter((r) => r.consensus.label === 'REVIEW').length;
  const fail = results.filter((r) => r.consensus.label === 'FAIL').length;
  const cInvoked = results.filter((r) => r.consensus.judge_c_invoked).length;
  const aOk = results.filter((r) => r.judges.A?.status === 'ok').length;
  const bOk = results.filter((r) => r.judges.B?.status === 'ok').length;
  const providerFailures = results.filter((r) =>
    [r.judges.A, r.judges.B, r.judges.C].some((j) => j?.status === 'provider_error'),
  ).length;
  const parserFailures = results.filter((r) =>
    [r.judges.A, r.judges.B, r.judges.C].some((j) => j?.status === 'parse_failure'),
  ).length;
  const agreement = results.filter(
    (r) =>
      r.judges.A?.status === 'ok' &&
      r.judges.B?.status === 'ok' &&
      r.judges.A?.output?.publishable === r.judges.B?.output?.publishable,
  ).length;
  const bothOk = results.filter((r) => r.judges.A?.status === 'ok' && r.judges.B?.status === 'ok').length;

  const metrics = {
    sample_size: results.length,
    pass: ok,
    review,
    fail,
    judge_c_invocation_rate: results.length > 0 ? cInvoked / results.length : 0,
    judge_c_invoked_count: cInvoked,
    judge_a_ok: aOk,
    judge_b_ok: bOk,
    a_b_agreement_rate: bothOk > 0 ? agreement / bothOk : null,
    a_b_agree_count: agreement,
    a_b_both_ok_count: bothOk,
    provider_failure_count: providerFailures,
    parser_failure_count: parserFailures,
    pass_rate_by_episode: countBy(results, 'episode_id', 'PASS'),
    pass_rate_by_original_failure_reason: passByStratum(results, manifest),
  };
  fs.writeFileSync(path.resolve(outDir, 'benchmark_metrics.json'), JSON.stringify(metrics, null, 2), 'utf-8');
  console.log(JSON.stringify(metrics, null, 2));
}

function failedCall(tier: 'A' | 'B'): JudgeCall {
  return {
    tier,
    providerId: 'none',
    model: 'none',
    raw_text: '',
    output: null,
    status: 'provider_error',
    error: 'skipped',
    attempts: 0,
    input_tokens: null,
    output_tokens: null,
    duration_ms: 0,
  };
}

function countBy(results: BenchmarkResult[], key: 'episode_id', label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    if (r.consensus.label !== label) continue;
    out[r.episode_id] = (out[r.episode_id] ?? 0) + 1;
  }
  return out;
}

function passByStratum(results: BenchmarkResult[], manifest: SampleManifest): Record<string, number> {
  const stratumOf = new Map(manifest.sample.map((e) => [e.candidate_id, e.stratum]));
  const out: Record<string, number> = {};
  for (const r of results) {
    if (r.consensus.label !== 'PASS') continue;
    const s = stratumOf.get(r.candidate_id) ?? 'unknown';
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

void main();