/**
 * Brief V14R — deterministic every-20th FAIL audit (frozen P1 addendum).
 *
 * Population: 150 V14 silver-FAIL (evidence/v14/silver_labels_v14.jsonl).
 * Sampling  : candidate_id ascending (byte order); 1-indexed positions
 *             20, 40, 60, 80, 100, 120, 140  => exactly 7 candidates.
 * Judge     : independent tier C (cx/gpt-5.6-luna) for ALL 7 even when
 *             A/B agree; blinded — input is PRE/CANDIDATE/POST transcript
 *             windows only, never selector scores/gates/variants/labels.
 * Label rules: audit publishable=false  => retain FAIL;
 *              audit publishable=true   => REVIEW + erratum (contradiction);
 *              provider/parse failure   => REVIEW + erratum (never invented).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { buildJudgeInput } from '../src/lib/v12r/judge-input';
import { callJudge } from '../src/lib/v12r/judge-runner';
import { loadJsonlStrict } from '../src/lib/v14/artifact-paths';
import { ensureJudgeEnv } from './judge-env';

const R = (p: string): string => path.resolve(p);
const OUT_DIR = 'evidence/v14r';
const SAMPLE_OFFSETS = [20, 40, 60, 80, 100, 120, 140];

interface LabelRow {
  candidate_id: string;
  episode_id: string;
  window: { start_sec: number; end_sec: number };
  label: string;
}

function originalLabels(): Map<string, LabelRow> {
  const rows = loadJsonlStrict(R('evidence/v14/silver_labels_v14.jsonl')) as unknown as LabelRow[];
  return new Map(rows.map((r) => [r.candidate_id, r]));
}

function selectSample(): { candidate_id: string; episode_id: string; window: { start_sec: number; end_sec: number } }[] {
  const labels = originalLabels();
  const fails = Array.from(labels.values())
    .filter((l) => l.label === 'FAIL')
    .map((l) => l.candidate_id)
    .sort();
  const selected = SAMPLE_OFFSETS.map((pos) => {
    const id = fails[pos - 1];
    if (!id) throw new Error(`FAIL_AUDIT_SAMPLE_INVALID: position ${pos} of ${fails.length} FAILs`);
    const row = labels.get(id)!;
    return { candidate_id: id, episode_id: row.episode_id, window: row.window };
  });
  return selected;
}

async function main(): Promise<void> {
  // Self-healing judge environment: fixes empty OPENAI_API_KEY and unreachable
  // base URLs (host.docker.internal) BEFORE any provider call (Brief V14R tooling).
  await ensureJudgeEnv({ envFile: process.env.JUDGE_ENV_FILE });
  const outDir = R(OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const judgePath = path.join(outDir, 'fail_audit_judge_outputs.jsonl');

  const sample = selectSample();
  fs.writeFileSync(
    path.join(outDir, 'fail_audit_sample.json'),
    JSON.stringify({ offsets: SAMPLE_OFFSETS, sampled_candidates: sample, count: sample.length }, null, 2),
    'utf-8',
  );
  console.log(`[v14r-audit] sample: ${sample.map((s) => s.candidate_id).join(', ')}`);

  const done = loadOkCandidateIds(judgePath);
  for (const entry of sample) {
    if (done.has(entry.candidate_id)) {
      console.warn(`[v14r-audit] skip (done) ${entry.candidate_id}`);
      continue;
    }
    const transcript = getTranscript(entry.episode_id);
    if (!transcript || transcript.cues.length === 0) {
      appendRow(judgePath, {
        candidate_id: entry.candidate_id,
        episode_id: entry.episode_id,
        window: entry.window,
        tier: 'AUDIT',
        status: 'provider_error',
        error: 'no_transcript',
        input_hash: '',
      });
      continue;
    }
    const contract = buildJudgeInput(
      transcript,
      { startSec: entry.window.start_sec, endSec: entry.window.end_sec },
      entry.candidate_id,
    );
    const inputHash = createHash('sha256').update(JSON.stringify(contract)).digest('hex');
    const call = await callJudge('C', contract);
    appendRow(judgePath, {
      candidate_id: entry.candidate_id,
      episode_id: entry.episode_id,
      window: entry.window,
      tier: 'AUDIT',
      prompt_version: 'judge-prompts/v12r@v14r-audit',
      input_hash: inputHash,
      providerId: call.providerId,
      model: call.model,
      raw_text: call.raw_text,
      output: call.output,
      status: call.status,
      error: call.error,
      attempts: call.attempts,
      input_tokens: call.input_tokens,
      output_tokens: call.output_tokens,
      duration_ms: call.duration_ms,
    });
    console.warn(`[v14r-audit] ${entry.candidate_id} -> ${call.status}`);
  }

  buildConsensus(outDir, judgePath);
}

function loadOkCandidateIds(judgePath: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(judgePath)) return out;
  for (const line of fs.readFileSync(judgePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { candidate_id?: string; status?: string };
    if (row.candidate_id && row.status === 'ok') out.add(row.candidate_id);
  }
  return out;
}

function appendRow(p: string, row: Record<string, unknown>): void {
  fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf-8');
}

interface AuditOutcomeRow extends Record<string, unknown> {
  candidate_id: string;
  status: string;
  output: { publishable?: boolean } | null;
  error: string | null;
}

function buildConsensus(outDir: string, judgePath: string): void {
  if (!fs.existsSync(judgePath)) {
    throw new Error('MISSING_REQUIRED_ARTIFACT: fail_audit_judge_outputs.jsonl');
  }
  const rows = loadJsonlStrict(judgePath) as unknown as AuditOutcomeRow[];
  const labels = originalLabels();
  const outRows: Record<string, unknown>[] = [];
  const errata: Record<string, unknown>[] = [];

  for (const row of rows) {
    const original = labels.get(row.candidate_id)?.label ?? null;
    let v14rLabel: string;
    let reason: string;
    if (row.status !== 'ok' || row.output === null) {
      v14rLabel = 'REVIEW';
      reason = `audit unavailable (${row.status}: ${row.error ?? 'unparseable'})`;
    } else if (row.output.publishable === true) {
      v14rLabel = 'REVIEW';
      reason = 'audit judge believes publishable (contradicts A/B FAIL)';
    } else {
      v14rLabel = 'FAIL';
      reason = 'audit agrees with A/B FAIL consensus';
    }
    outRows.push({
      candidate_id: row.candidate_id,
      original_label: original,
      v14r_label: v14rLabel,
      rule: 'AUDIT_C',
      reason,
      audit_status: row.status,
    });
    if (v14rLabel !== original) {
      errata.push({ candidate_id: row.candidate_id, old_label: original, new_label: v14rLabel, reason });
    }
  }

  fs.writeFileSync(path.join(outDir, 'consensus_labels_v14r.jsonl'), outRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(outDir, 'label_errata_v14r.jsonl'), errata.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  console.log(`[v14r-audit] consensus: ${outRows.map((r) => `${r.candidate_id}:${r.v14r_label}`).join(', ')}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});