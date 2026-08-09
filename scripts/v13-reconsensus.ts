/**
 * Brief V13 Phase B — Re-run the V12R 51-candidate benchmark through the
 * HARDENED consensus, OFFLINE (reuses the persisted judge outputs — no new
 * LLM calls), and records every label change.
 *
 * Judge outputs live in evidence/v12r/judge_outputs.jsonl; each row has
 * candidate_id + tier + status + output. This script re-derives A/B/C calls
 * per candidate and applies decideConsensusV13.
 *
 * Usage:
 *   node --import tsx scripts/v13-reconsensus.ts \
 *     --outputs evidence/v12r/judge_outputs.jsonl \
 *     --out-dir evidence/v13 \
 *     [--informer evidence/v12r/consensus_labels.jsonl]
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JudgeCall, JudgeTier } from '../src/lib/v12r/judge-types';
import { decideConsensusV13 } from '../src/lib/v13r/consensus-v2';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

interface OutputRow {
  candidate_id: string;
  episode_id: string;
  window: { start_sec: number; end_sec: number };
  tier: JudgeTier;
  status: JudgeCall['status'];
  output: JudgeCall['output'];
  raw_text?: string;
  error?: string | null;
}

function main(): void {
  const outputsPath = arg('outputs') ?? 'evidence/v12r/judge_outputs.jsonl';
  const outDir = arg('out-dir') ?? 'evidence/v13';
  const oldLabelsPath = arg('old') ?? 'evidence/v12r/consensus_labels.jsonl';

  const rows: OutputRow[] = fs
    .readFileSync(path.resolve(outputsPath), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as OutputRow);

  const byCandidate = new Map<string, { A?: OutputRow; B?: OutputRow; C?: OutputRow }>();
  for (const row of rows) {
    const entry = byCandidate.get(row.candidate_id) ?? { A: undefined, B: undefined, C: undefined };
    if (row.tier === 'A') entry.A = row;
    else if (row.tier === 'B') entry.B = row;
    else if (row.tier === 'C') entry.C = row;
    byCandidate.set(row.candidate_id, entry);
  }

  const oldLabels = new Map<string, string>();
  if (fs.existsSync(path.resolve(oldLabelsPath))) {
    for (const line of fs.readFileSync(path.resolve(oldLabelsPath), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as { candidate_id: string; label: string };
      if (rec.candidate_id) oldLabels.set(rec.candidate_id, rec.label);
    }
  }

  const results: Record<string, unknown>[] = [];
  const changes: { candidate_id: string; before: string; after: string; veto?: string | null }[] = [];

  for (const [candidateId, calls] of byCandidate) {
    if (!calls.A || !calls.B) continue; // needs both A and B to decide
    const judgeACall: JudgeCall = rowToCall(calls.A, 'A');
    const judgeBCall: JudgeCall = rowToCall(calls.B, 'B');
    const judgeCCall: JudgeCall | null = calls.C ? rowToCall(calls.C, 'C') : null;

    const hardened = decideConsensusV13(judgeACall, judgeBCall, judgeCCall);
    const before = oldLabels.get(candidateId) ?? null;
    const after = hardened.decision.label;
    if (before !== null && before !== after) {
      changes.push({ candidate_id: candidateId, before, after, veto: hardened.veto_reason });
    }

    results.push({
      candidate_id: candidateId,
      episode_id: calls.A.episode_id,
      window: calls.A.window,
      label: after,
      rule: hardened.decision.rule,
      judge_c_invoked: hardened.decision.judge_c_invoked,
      reason: hardened.decision.reason,
      veto_reason: hardened.veto_reason,
      old_label: before,
      label_changed: before !== null && before !== after,
    });
  }

  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  fs.writeFileSync(path.resolve(outDir, 'consensus_labels_v13.jsonl'), results.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');
  fs.writeFileSync(path.resolve(outDir, 'consensus_label_changes.jsonl'), changes.map((c) => JSON.stringify(c)).join('\n'), 'utf-8');

  const pass = results.filter((r) => r.label === 'PASS').length;
  const review = results.filter((r) => r.label === 'REVIEW').length;
  const fail = results.filter((r) => r.label === 'FAIL').length;
  const changed = changes.length;
  const oldPass = results.filter((r) => r.old_label === 'PASS').length;
  const lostPass = results.filter((r) => r.old_label === 'PASS' && r.label !== 'PASS').length;

  const summary = {
    candidates_rejudged: results.length,
    pass: { old: oldPass, new: pass, lost: lostPass },
    review,
    fail,
    label_changes: changed,
    changes,
    note: 'offline re-consensus using hardened critical vetoes; no new LLM calls',
  };
  fs.writeFileSync(path.resolve(outDir, 'hardening_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log(JSON.stringify(summary, null, 2));
}

function rowToCall(row: OutputRow, tier: JudgeTier): JudgeCall {
  return {
    tier,
    providerId: (row as unknown as { providerId?: string }).providerId ?? 'unknown',
    model: (row as unknown as { model?: string }).model ?? 'unknown',
    raw_text: row.raw_text ?? '',
    output: row.output ?? null,
    status: row.status === 'ok' ? 'ok' : row.status === 'parse_failure' ? 'parse_failure' : 'provider_error',
    error: row.error ?? null,
    attempts: (row as unknown as { attempts?: number }).attempts ?? 1,
    input_tokens: (row as unknown as { input_tokens?: number | null }).input_tokens ?? null,
    output_tokens: (row as unknown as { output_tokens?: number | null }).output_tokens ?? null,
    duration_ms: (row as unknown as { duration_ms?: number }).duration_ms ?? 0,
  };
}

main();