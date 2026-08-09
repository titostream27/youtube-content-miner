/**
 * Brief V14 Phase P2 — judge run for the four new episodes (blind labels).
 *
 * Same protocol as V13: Judge A (ds/deepseek-v4-flash) + Judge B
 * (ag/gemini-3.5-flash-low), Judge C (cx/gpt-5.6-luna) invoked on A/B
 * disagreement. Judges only receive PRE/CANDIDATE/POST transcript windows
 * (buildJudgeInput) — never selector scores or gates (blinding). Resume
 * supported: rows with A+B ok are skipped; --c-only re-runs missing C.
 *
 * Usage:
 *   DATABASE_PATH=... node --env-file=... --import tsx scripts/v14-judge-run.ts
 *     --manifest evidence/v14/new_manifest.json --out-dir evidence/v14
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { buildJudgeInput } from '../src/lib/v12r/judge-input';
import { callJudge } from '../src/lib/v12r/judge-runner';
import { ensureJudgeEnv } from './judge-env';
import { needsJudgeC } from '../src/lib/v12r/consensus';
import { decideConsensusV13 } from '../src/lib/v13r/consensus-v2';
import type { JudgeCall } from '../src/lib/v12r/judge-types';

interface ManifestEntry {
  candidate_id: string;
  episode_id: string;
  window: { start_sec: number; end_sec: number };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function loadCalls(judgePath: string, candidateId: string): { a: JudgeCall | null; b: JudgeCall | null; c: JudgeCall | null } {
  if (!fs.existsSync(judgePath)) return { a: null, b: null, c: null };
  const calls: (JudgeCall & { candidate_id?: string })[] = [];
  for (const line of fs.readFileSync(judgePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    calls.push(JSON.parse(line) as JudgeCall & { candidate_id?: string });
  }
  return {
    a: calls.find((c) => c.candidate_id === candidateId && c.tier === 'A') ?? null,
    b: calls.find((c) => c.candidate_id === candidateId && c.tier === 'B') ?? null,
    c: calls.find((c) => c.candidate_id === candidateId && c.tier === 'C') ?? null,
  };
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

function loadCompleted(outDir: string, judgeFile: string): Set<string> {
  const set = new Set<string>();
  const p = path.resolve(outDir, judgeFile);
  if (!fs.existsSync(p)) return set;
  const byId = new Map<string, Set<string>>();
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { candidate_id?: string; tier?: string; status?: string };
    if (!row.candidate_id || !row.tier) continue;
    if (!byId.has(row.candidate_id)) byId.set(row.candidate_id, new Set());
    if (row.status === 'ok') byId.get(row.candidate_id)!.add(row.tier);
  }
  for (const [id, tiers] of byId) {
    if (tiers.has('A') && tiers.has('B')) set.add(id);
  }
  return set;
}

async function main(): Promise<void> {
  await ensureJudgeEnv({ envFile: process.env.JUDGE_ENV_FILE });
  const manifestPath = arg('manifest') ?? 'evidence/v14/new_manifest.json';
  const outDir = arg('out-dir') ?? 'evidence/v14';
  const judgeFile = arg('judge-output') ?? 'judge_outputs_v14.jsonl';
  const labelFile = arg('labels') ?? 'silver_labels_v14.jsonl';
  const benchmarkVersion = arg('version') ?? 'v14.0';
  const concurrency = Math.min(6, Math.max(1, Number.parseInt(arg('concurrency') ?? '3', 10)));
  const cOnly = hasFlag('c-only');
  const limit = Number.parseInt(arg('limit') ?? '0', 10);

  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf-8')) as { candidates: ManifestEntry[] };
  const judgePath = path.resolve(outDir, judgeFile);
  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  if (!fs.existsSync(judgePath)) fs.writeFileSync(judgePath, '', 'utf-8');

  let entries: ManifestEntry[];
  if (cOnly) {
    entries = [];
    for (const e of manifest.candidates) {
      const calls = loadCalls(judgePath, e.candidate_id);
      if (!calls.a || !calls.b) continue;
      if (calls.a.status !== 'ok' || calls.b.status !== 'ok') continue;
      if (calls.c && calls.c.status === 'ok') continue;
      if (!needsJudgeC(calls.a, calls.b)) continue;
      entries.push(e);
    }
  } else {
    const doneSet = loadCompleted(outDir, judgeFile);
    entries = manifest.candidates.filter((e) => !doneSet.has(e.candidate_id));
  }
  if (limit > 0) entries = entries.slice(0, limit);

  let done = 0;
  const stats = { pass: 0, review: 0, fail: 0, provider_fail: 0, parse_fail: 0, c_invoked: 0 };

  const processOne = async (entry: ManifestEntry): Promise<void> => {
    const transcript = getTranscript(entry.episode_id);
    if (!transcript || transcript.cues.length === 0) {
      done += 1;
      console.warn(`[v14-judge] skip ${entry.candidate_id}: no transcript`);
      return;
    }
    const contract = buildJudgeInput(
      transcript,
      { startSec: entry.window.start_sec, endSec: entry.window.end_sec },
      entry.candidate_id,
    );

    let judgeA: JudgeCall | null = null;
    let judgeB: JudgeCall | null = null;
    let judgeC: JudgeCall | null = null;

    if (cOnly) {
      const existing = loadCalls(judgePath, entry.candidate_id);
      judgeA = existing.a;
      judgeB = existing.b;
      const needC = existing.c && existing.c.status === 'ok' ? existing.c : await callJudge('C', contract);
      if (needC.status === 'ok') judgeC = needC;
      if (judgeC) {
        fs.appendFileSync(judgePath, `${JSON.stringify({ candidate_id: entry.candidate_id, episode_id: entry.episode_id, window: entry.window, ...judgeC })}\n`, 'utf-8');
      }
      done += 1;
      console.warn(`[v14-judge:c-only] ${done}/${entries.length} ${entry.candidate_id} C=${judgeC?.status ?? 'none'}`);
      return;
    }

    judgeA = await callJudge('A', contract);
    judgeB = await callJudge('B', contract);
    if (judgeA && judgeB && needsJudgeC(judgeA, judgeB)) {
      judgeC = await callJudge('C', contract);
      stats.c_invoked += 1;
    }

    const verdict = decideConsensusV13(judgeA ?? failedCall('A'), judgeB ?? failedCall('B'), judgeC);
    const outLines: string[] = [];
    for (const j of [judgeA, judgeB, judgeC]) {
      if (j) outLines.push(JSON.stringify({ candidate_id: entry.candidate_id, episode_id: entry.episode_id, window: entry.window, ...j }));
    }
    if (outLines.length > 0) fs.appendFileSync(judgePath, outLines.join('\n') + '\n', 'utf-8');

    fs.appendFileSync(
      path.resolve(outDir, labelFile),
      `${JSON.stringify({
        benchmark_version: benchmarkVersion,
        candidate_id: entry.candidate_id,
        episode_id: entry.episode_id,
        window: entry.window,
        label: verdict.decision.label,
        rule: verdict.decision.rule,
        judge_c_invoked: verdict.decision.judge_c_invoked,
        reason: verdict.decision.reason,
        veto_reason: verdict.veto_reason,
        votes: verdict.decision.votes,
        labeled_at: new Date().toISOString(),
        labeler_version: benchmarkVersion,
      })}\n`,
      'utf-8',
    );

    if (verdict.decision.label === 'PASS') stats.pass += 1;
    else if (verdict.decision.label === 'FAIL') stats.fail += 1;
    else stats.review += 1;
    if ([judgeA, judgeB, judgeC].some((j) => j?.status === 'provider_error')) stats.provider_fail += 1;
    if ([judgeA, judgeB, judgeC].some((j) => j?.status === 'parse_failure')) stats.parse_fail += 1;

    done += 1;
    console.warn(`[v14-judge] ${done}/${entries.length} ${entry.candidate_id} -> ${verdict.decision.label}`);
  };

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(batch.map(processOne));
  }

  const summary = {
    mode: cOnly ? 'c-only' : 'full A/B (+C on disagreement)',
    benchmark_version: benchmarkVersion,
    candidates_pending_at_start: entries.length,
    completed_total: done,
    stats,
  };
  fs.writeFileSync(path.resolve(outDir, 'judge_run_summary_v14.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});