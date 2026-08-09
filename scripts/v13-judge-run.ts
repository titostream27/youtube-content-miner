/**
 * Brief V13 Phase C — Expanded silver-benchmark judge run with resume.
 *
 * Modes:
 *  - default: Judge A + B over every manifest candidate, Judge C invoked on
 *    A/B disagreement (full-pool consensus).
 *  - --c-only: re-run ONLY Judge C for candidates whose A+B verdicts exist
 *    and disagree but whose C verdict is missing/failed on disk. Judge
 *    output rows are appended; the consensus file is NOT touched here —
 *    run scripts/v13-reconsensus.ts afterwards to rebuild labels (offline,
 *    deterministic).
 *
 * Judge C channel fix (2026-08-09): the 9router gateway accepts the
 * DEEPSEEK_API_KEY value for the "openai" provider channel too, so exports
 * OPENAI_API_KEY=<deepseek key value> + OPENAI_BASE_URL=127.0.0.1:20128/v1
 * makes cx/* verdicts work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { buildJudgeInput } from '../src/lib/v12r/judge-input';
import { callJudge } from '../src/lib/v12r/judge-runner';
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

/** Candidates whose A+B content verdicts already exist as ok on disk. */
function loadCompleted(outDir: string): Set<string> {
  const set = new Set<string>();
  const p = path.resolve(outDir, 'judge_outputs.jsonl');
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

/** Load the A/B/C calls for a candidate from disk. */
function loadCalls(judgePath: string, candidateId: string): { a: JudgeCall | null; b: JudgeCall | null; c: JudgeCall | null } {
  if (!fs.existsSync(judgePath)) return { a: null, b: null, c: null };
  const calls: JudgeCall[] = [];
  for (const line of fs.readFileSync(judgePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as JudgeCall & { candidate_id?: string };
    if (row.candidate_id === candidateId) calls.push(row);
  }
  return {
    a: calls.find((c) => c.tier === 'A') ?? null,
    b: calls.find((c) => c.tier === 'B') ?? null,
    c: calls.find((c) => c.tier === 'C') ?? null,
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

async function main(): Promise<void> {
  const manifestPath = arg('manifest') ?? 'evidence/v13/benchmark_manifest.json';
  const outDir = arg('out-dir') ?? 'evidence/v13';
  const limit = Number.parseInt(arg('limit') ?? '0', 10);
  const concurrency = Math.min(6, Math.max(1, Number.parseInt(arg('concurrency') ?? '3', 10)));
  const skipA = hasFlag('skip-a');
  const skipB = hasFlag('skip-b');
  const skipC = hasFlag('skip-c');
  const cOnly = hasFlag('c-only');

  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf-8')) as {
    candidates: ManifestEntry[];
  };
  const judgePath = path.resolve(outDir, 'judge_outputs.jsonl');
  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  if (!fs.existsSync(judgePath)) fs.writeFileSync(judgePath, '', 'utf-8');

  // Normal mode: candidates missing A+B ok. C-only mode: candidates whose
  // A+B are ok but C is missing/failed AND A/B actually disagree.
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
    const doneSet = loadCompleted(outDir);
    entries = manifest.candidates.filter((e) => !doneSet.has(e.candidate_id));
  }
  if (limit > 0) entries = entries.slice(0, limit);

  let done = 0;
  const stats = { pass: 0, review: 0, fail: 0, provider_fail: 0, parse_fail: 0, c_invoked: 0 };

  const processOne = async (entry: ManifestEntry): Promise<void> => {
    const transcript = getTranscript(entry.episode_id);
    if (!transcript || transcript.cues.length === 0) {
      done += 1;
      console.warn(`[v13-judge] skip ${entry.candidate_id}: no transcript`);
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
      // C-only: append ONLY the new C row; consensus rebuilt offline.
      if (judgeC) {
        fs.appendFileSync(
          judgePath,
          `${JSON.stringify({ candidate_id: entry.candidate_id, episode_id: entry.episode_id, window: entry.window, ...judgeC })}\n`,
          'utf-8',
        );
      }
      if ([judgeC].some((j) => j?.status === 'provider_error')) stats.provider_fail += 1;
      if ([judgeC].some((j) => j?.status === 'parse_failure')) stats.parse_fail += 1;
      done += 1;
      console.warn(`[v13-judge:c-only] ${done}/${entries.length} ${entry.candidate_id} C=${judgeC?.status ?? 'none'}`);
      return;
    }

    judgeA = skipA ? null : await callJudge('A', contract);
    judgeB = skipB ? null : await callJudge('B', contract);
    if (!skipC && judgeA && judgeB && needsJudgeC(judgeA, judgeB)) {
      judgeC = await callJudge('C', contract);
      stats.c_invoked += 1;
    }

    const verdict = decideConsensusV13(
      judgeA ?? failedCall('A'),
      judgeB ?? failedCall('B'),
      judgeC,
    );

    const outLines: string[] = [];
    for (const j of [judgeA, judgeB, judgeC]) {
      if (j) outLines.push(JSON.stringify({ candidate_id: entry.candidate_id, episode_id: entry.episode_id, window: entry.window, ...j }));
    }
    if (outLines.length > 0) fs.appendFileSync(judgePath, outLines.join('\n') + '\n', 'utf-8');

    fs.appendFileSync(
      path.resolve(outDir, 'consensus_labels_v13.jsonl'),
      `${JSON.stringify({
        candidate_id: entry.candidate_id,
        episode_id: entry.episode_id,
        window: entry.window,
        label: verdict.decision.label,
        rule: verdict.decision.rule,
        judge_c_invoked: verdict.decision.judge_c_invoked,
        reason: verdict.decision.reason,
        veto_reason: verdict.veto_reason,
        votes: verdict.decision.votes,
      })}\n`,
      'utf-8',
    );

    if (verdict.decision.label === 'PASS') stats.pass += 1;
    else if (verdict.decision.label === 'FAIL') stats.fail += 1;
    else stats.review += 1;
    if ([judgeA, judgeB, judgeC].some((j) => j?.status === 'provider_error')) stats.provider_fail += 1;
    if ([judgeA, judgeB, judgeC].some((j) => j?.status === 'parse_failure')) stats.parse_fail += 1;

    done += 1;
    console.warn(`[v13-judge] ${done}/${entries.length} ${entry.candidate_id} -> ${verdict.decision.label}`);
  };

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(batch.map(processOne));
  }

  const summary = {
    mode: cOnly ? 'c-only (Judge C re-run for A/B disagreements)' : 'full A/B (+C on disagreement)',
    candidates_pending_at_start: entries.length,
    completed_total: done,
    stats,
    note: cOnly
      ? 'run scripts/v13-reconsensus.ts afterwards to rebuild consensus_labels_v13.jsonl'
      : undefined,
  };
  fs.writeFileSync(path.resolve(outDir, 'judge_run_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});