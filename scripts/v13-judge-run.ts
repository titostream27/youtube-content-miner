/**
 * Brief V13 Phase C — Expanded silver-benchmark judge run with resume.
 *
 * Strategy: full 344-pool A/B consensus (preferred §7), Judge C invoked on
 * disagreement. Candidates whose A+B outputs already exist (ok status) in
 * judge_outputs.jsonl are skipped, so interrupted runs resume safely.
 *
 * Usage:
 *   DATABASE_PATH=... node --import tsx scripts/v13-judge-run.ts \
 *     --manifest evidence/v13/benchmark_manifest.json \
 *     --out-dir evidence/v13 \
 *     [--limit N] [--concurrency 3] [--skip-a|--skip-b|--skip-c]
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

/** Candidates whose A+B content verdicts already exist on disk. */
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
    // C-only mode needs candidates whose C verdict is missing or failed;
    // they are added ONLY when we are re-routing C (must not reprocess
    // candidates that already have a working C verdict).
  }
  return set;
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

  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf-8')) as {
    candidates: ManifestEntry[];
  };
  const doneSet = loadCompleted(outDir);

  let entries = manifest.candidates.filter((e) => !doneSet.has(e.candidate_id));
  if (limit > 0) entries = entries.slice(0, limit);

  // --c-only: only candidates whose consensus row exists as INCOMPLETE_VOTES
  // (C failed on disagreement) get a C call; A/B are reused from disk.
  const cOnly = hasFlag('c-only');

  // In c-only mode process only candidates whose current consensus is a
  // dead C (INCOMPLETE_VOTES) and whose A/B calls exist on disk.
  let targetIds: Set<string> | null = null;
  if (cOnly) {
    targetIds = incompleteVotesCandidates(path.resolve(outDir, 'consensus_labels_v13.jsonl'));
    entries = entries.filter((e) => (targetIds as Set<string>).has(e.candidate_id));
  }

  const judgePath = path.resolve(outDir, 'judge_outputs.jsonl');
  const consensusPath = path.resolve(outDir, 'consensus_labels_v13.jsonl');
  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  if (!fs.existsSync(judgePath)) fs.writeFileSync(judgePath, '', 'utf-8');
  if (!fs.existsSync(consensusPath)) fs.writeFileSync(consensusPath, '', 'utf-8');

  const version = process.env.V13_BENCHMARK_VERSION?.trim() || 'v13.0';
  let done = 0;
  const stats = { pass: 0, review: 0, fail: 0, provider_fail: 0, parse_fail: 0, c_invoked: 0 };
function loadCalls(outDir: string, candidateId: string, judgePath: string): { a: JudgeCall | null; b: JudgeCall | null; c: JudgeCall | null } {
  if (!fs.existsSync(judgePath)) return { a: null, b: null, c: null };
  const calls: JudgeCall[] = [];
  for (const line of fs.readFileSync(judgePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as JudgeCall & { candidate_id?: string };
    if (row.candidate_id === candidateId) calls.push(row);
  }
  const a = calls.find((c) => c.tier === 'A') ?? null;
  const b = calls.find((c) => c.tier === 'B') ?? null;
  const c = calls.find((c) => c.tier === 'C') ?? null;
  return { a, b, c };
}

/** Candidates whose consensus row says C failed (INCOMPLETE_VOTES). */
function incompleteVotesCandidates(consensusPath: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(consensusPath)) return out;
  for (const line of fs.readFileSync(consensusPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { candidate_id?: string; rule?: string };
    if (rec.candidate_id && rec.rule === 'INCOMPLETE_VOTES') out.add(rec.candidate_id);
  }
  return out;
}

const processOne = async (entry: ManifestEntry): Promise<void> => {
    const transcript = getTranscript(entry.episode_id);
    if (!transcript || transcript.cues.length === 0) {
      fs.appendFileSync(
        consensusPath,
        `${JSON.stringify({ benchmark_version: version, candidate_id: entry.candidate_id, episode_id: entry.episode_id, window: entry.window, label: 'REVIEW', rule: 'NO_TRANSCRIPT', reason: 'no cached transcript', veto_reason: null })}\n`,
        'utf-8',
      );
      done += 1;
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
      const existing = loadCalls(outDir, entry.candidate_id, judgePath);
      judgeA = existing.a;
      judgeB = existing.b;
      const needC = !existing.c || existing.c.status !== 'ok'
        ? await callJudge('C', contract)
        : existing.c;
      if (needC && needC.status === 'ok') judgeC = needC;
    } else {
      judgeA = skipA ? null : await callJudge('A', contract);
      judgeB = skipB ? null : await callJudge('B', contract);
      if (!skipC && judgeA && judgeB && needsJudgeC(judgeA, judgeB)) {
        judgeC = await callJudge('C', contract);
      }
    }

    const verdict = decideConsensusV13(
      judgeA ?? failedCall('A'),
      judgeB ?? failedCall('B'),
      judgeC,
    );

    const outLines: string[] = [];
    for (const j of [judgeA, judgeB, judgeC]) {
      if (j) {
        outLines.push(JSON.stringify({ candidate_id: entry.candidate_id, episode_id: entry.episode_id, window: entry.window, ...j }));
      }
    }
    if (outLines.length > 0) {
      fs.appendFileSync(judgePath, outLines.join('\n') + '\n', 'utf-8');
    }

    fs.appendFileSync(
      consensusPath,
      `${JSON.stringify({
        benchmark_version: version,
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

    stats[labelOf(verdict.decision.label)] += 1;
    if (verdict.decision.judge_c_invoked) stats.c_invoked += 1;
    if ([judgeA, judgeB, judgeC].some((j) => j?.status === 'provider_error')) stats.provider_fail += 1;
    if ([judgeA, judgeB, judgeC].some((j) => j?.status === 'parse_failure')) stats.parse_fail += 1;

    done += 1;
    console.warn(`[v13-judge] ${done}/${entries.length} ${entry.candidate_id} -> ${verdict.decision.label}`);
  };

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(batch.map(processOne));
  }

  // C-only mode: replace the old INCOMPLETE_VOTES rows with the new labels
  // so the consensus file never carries stale duplicates.
  if (cOnly && targetIds && targetIds.size > 0) {
    const lines = fs.readFileSync(consensusPath, 'utf-8').split('\n').filter((l) => l.trim());
    const kept = lines.filter((l) => {
      try {
        const rec = JSON.parse(l) as { candidate_id?: string };
        return !rec.candidate_id || !targetIds.has(rec.candidate_id);
      } catch {
        return true;
      }
    });
    fs.writeFileSync(consensusPath, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8');
  }

  const summary = {
    candidates_pending_at_start: entries.length,
    completed_total: done,
    stats,
  };
  fs.writeFileSync(path.resolve(outDir, 'judge_run_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log(JSON.stringify(summary, null, 2));
}

function labelOf(label: string): 'pass' | 'review' | 'fail' {
  if (label === 'PASS') return 'pass';
  if (label === 'FAIL') return 'fail';
  return 'review';
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});