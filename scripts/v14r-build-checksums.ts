/**
 * Brief V14R Workstream B — non-circular immutable checksum builder.
 *
 * - Hashes an explicit allowlist of IMMUTABLE evidence (source artifacts +
 *   V14R audit outputs), repository-relative POSIX paths, LF-normalized text.
 * - NEVER includes SHA256SUMS itself, run_summary.json (written_at), old
 *   verification_report.json (generated_at) or census_new.jsonl (acquired_at).
 * - LF normalization makes Linux AND Windows produce identical hashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function findRoot(start: string): string {
  let d = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'evidence'))) return d;
    d = path.dirname(d);
  }
  throw new Error('ROOT_NOT_FOUND');
}

const ROOT = findRoot(__dirname);
const OUT = path.join(ROOT, 'evidence', 'v14r', 'SHA256SUMS');

/** Explicit immutable allowlist (repository-relative, POSIX). */
const IMMUTABLE: string[] = [
  // V14 source evidence (immutable historical inputs)
  'evidence/v14/baseline.json',
  'evidence/v14/candidates.csv',
  'evidence/v14/episode_manifest.csv',
  'evidence/v14/metrics_aggregate.json',
  'evidence/v14/new_manifest.json',
  'evidence/v14/policy_lock.json',
  'evidence/v14/production_diff.txt',
  'evidence/v14/sha256sums_v13_artifacts.txt',
  'evidence/v14/silver_labels_v14.jsonl',
  'evidence/v14/split_lock.json',
  'evidence/v14/judge_outputs_v14.jsonl',
  'evidence/v14/judge_run_summary_v14.json',
  'evidence/v14/control/tracer_manifest.jsonl',
  'evidence/v14/control/traces.jsonl',
  'evidence/v14/control/tracer_summary.json',
  'evidence/v14/control/stage_metrics.json',
  'evidence/v14/control/first_death_matrix.csv',
  'evidence/v14/control/herd_suppression.json',
  'evidence/v14/control_repro/tracer_manifest.jsonl',
  'evidence/v14/control_repro/traces.jsonl',
  'evidence/v14/control_repro/tracer_summary.json',
  'evidence/v14/control_repro/stage_metrics.json',
  'evidence/v14/control_repro/first_death_matrix.csv',
  'evidence/v14/control_repro/herd_suppression.json',
  // V14 variant outcomes (fixed at commit time; no timestamps hashed)
  'evidence/v14/runs/c0/C0/variant_results.jsonl',
  'evidence/v14/runs/c0/C0/stage_trace.jsonl',
  'evidence/v14/runs/c0/C0/first_death.csv',
  'evidence/v14/runs/c0/C0/score_contributions.csv',
  'evidence/v14/runs/c0/C0/metrics.json',
  'evidence/v14/runs/E1/E1/variant_results.jsonl',
  'evidence/v14/runs/E1/E1/stage_trace.jsonl',
  'evidence/v14/runs/E1/E1/first_death.csv',
  'evidence/v14/runs/E1/E1/score_contributions.csv',
  'evidence/v14/runs/E1/E1/metrics.json',
  'evidence/v14/runs/E2/E2/variant_results.jsonl',
  'evidence/v14/runs/E2/E2/stage_trace.jsonl',
  'evidence/v14/runs/E2/E2/first_death.csv',
  'evidence/v14/runs/E2/E2/score_contributions.csv',
  'evidence/v14/runs/E2/E2/metrics.json',
  'evidence/v14/runs/E3/E3/variant_results.jsonl',
  'evidence/v14/runs/E3/E3/stage_trace.jsonl',
  'evidence/v14/runs/E3/E3/first_death.csv',
  'evidence/v14/runs/E3/E3/score_contributions.csv',
  'evidence/v14/runs/E3/E3/metrics.json',
  'evidence/v14/runs/E4/E4/variant_results.jsonl',
  'evidence/v14/runs/E4/E4/stage_trace.jsonl',
  'evidence/v14/runs/E4/E4/first_death.csv',
  'evidence/v14/runs/E4/E4/score_contributions.csv',
  'evidence/v14/runs/E4/E4/metrics.json',
  'evidence/v14/runs/S1/S1/variant_results.jsonl',
  'evidence/v14/runs/S1/S1/stage_trace.jsonl',
  'evidence/v14/runs/S1/S1/first_death.csv',
  'evidence/v14/runs/S1/S1/score_contributions.csv',
  'evidence/v14/runs/S1/S1/metrics.json',
  'evidence/v14/runs/S2/S2/variant_results.jsonl',
  'evidence/v14/runs/S2/S2/stage_trace.jsonl',
  'evidence/v14/runs/S2/S2/first_death.csv',
  'evidence/v14/runs/S2/S2/score_contributions.csv',
  'evidence/v14/runs/S2/S2/metrics.json',
  'evidence/v14/runs/NEGATIVE_CONTROL/NEGATIVE_CONTROL/variant_results.jsonl',
  'evidence/v14/runs/NEGATIVE_CONTROL/NEGATIVE_CONTROL/stage_trace.jsonl',
  'evidence/v14/runs/NEGATIVE_CONTROL/NEGATIVE_CONTROL/first_death.csv',
  'evidence/v14/runs/NEGATIVE_CONTROL/NEGATIVE_CONTROL/score_contributions.csv',
  'evidence/v14/runs/NEGATIVE_CONTROL/NEGATIVE_CONTROL/metrics.json',
];

/** V14R audit outputs become immutable after this commit (R-03: the two
 * self-referential/mutable outputs below are deliberately EXCLUDED:
 * evidence/v14r/verification_report.json (self-referential report) and
 * evidence/v14r/ci_run_metadata.json (updated post-CI). PLUS
 * evidence/v14r/checksum_reconciliation.json contains the manifest SHA-256 in
 * its content; hashing it inside the manifest would be circular, so it is
 * excluded and published as a standalone reconciliation record. */
const IMMUTABLE_V14R: string[] = [
  'evidence/v14r/baseline_reproduction.json',
  'evidence/v14r/path_case_audit.json',
  'evidence/v14r/old_checksum_failures.json',
  'evidence/v14r/fail_audit_sample.json',
  'evidence/v14r/fail_audit_judge_outputs.jsonl',
  'evidence/v14r/consensus_labels_v14r.jsonl',
  'evidence/v14r/label_errata_v14r.jsonl',
  'evidence/v14r/metrics_v14r.json',
  'evidence/v14r/policy_reconciliation.json',
  'evidence/v14r/report_claims.json',
  'evidence/v14r/production_diff.txt',
  'evidence/v14r/test_report.json',
];

function lfNormalized(p: string): Buffer {
  const raw = fs.readFileSync(p);
  return Buffer.from(raw.toString('utf-8').replace(/\r\n/g, '\n'), 'utf-8');
}

function sha256Text(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function main(): void {
  const entries: { rel: string; hash: string }[] = [];
  const missing: string[] = [];
  for (const rel of [...IMMUTABLE, ...IMMUTABLE_V14R]) {
    const abs = path.join(ROOT, ...rel.split('/'));
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    entries.push({ rel, hash: sha256Text(lfNormalized(abs)) });
  }
  if (missing.length > 0) {
    throw new Error(`MISSING_IMMUTABLE: ${missing.join(', ')}`);
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const lines = entries.map((e) => `${e.hash}  ${e.rel}`);
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf-8');
  console.log(`SHA256SUMS written: ${entries.length} entries (self-excluded, mutable-excluded)`);
  console.log(`manifest_sha256=${sha256Text(fs.readFileSync(OUT, 'utf-8'))}`);
}

main();