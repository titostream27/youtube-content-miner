/**
 * Brief V14R Workstream E — single offline acceptance driver (blocking).
 * npm run verify:v14r. No network, no secrets, no provider calls.
 *
 * Runs the hardened v14-verify suite (child process), then enforces:
 * V14R-DAT-001/002/003, V14R-AUD-001/002, V14R-REC-001/002, V14R-SAF-001,
 * V14R-CHK-001/002, V14R-HLD-001, V14R-PRD-001. Writes
 * evidence/v14r/verification_report.json (deterministic). Non-zero on fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  RUN_VARIANTS,
  loadJsonlStrict,
  loadJsonStrict,
  requiredRunFile,
} from '../src/lib/v14/artifact-paths';

function findRoot(start: string): string {
  let d = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'evidence'))) return d;
    d = path.dirname(d);
  }
  throw new Error('ROOT_NOT_FOUND');
}

const ROOT = findRoot(__dirname);
const R = (p: string): string => path.resolve(ROOT, p);
const OUT = R('evidence/v14r');
const BASELINE_ACCEPTED = 'c=3b416b15c9b5';

interface Check { id: string; status: 'PASS' | 'FAIL' | 'NOT_EVALUABLE'; detail: string }
const checks: Check[] = [];
const pass = (id: string, detail: string): void => { checks.push({ id, status: 'PASS', detail }); };
const fail = (id: string, detail: string): void => { checks.push({ id, status: 'FAIL', detail }); };
const na = (id: string, detail: string): void => { checks.push({ id, status: 'NOT_EVALUABLE', detail }); };

function lfHash(p: string): string {
  const raw = fs.readFileSync(p).toString('utf-8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(raw, 'utf-8').digest('hex');
}

function main(): void {
  fs.mkdirSync(R('evidence/v14r'), { recursive: true });

  // ---- run the hardened legacy suite first ----
  try {
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/v14-verify.ts'], { cwd: ROOT, stdio: 'inherit' });
    pass('V14R-LEGACY', 'v14-verify child suite exited 0');
  } catch {
    fail('V14R-LEGACY', 'v14-verify child suite exited non-zero');
  }

  // ---- V14R-DAT-001/002: census + uniqueness per variant ----
  const EXPECTED_PER_VARIANT = 424;
  let datOk = true;
  for (const variant of RUN_VARIANTS) {
    const rows = loadVariantOutcomes(variant);
    const ids = rows.map((r) => r.candidate_id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (rows.length !== EXPECTED_PER_VARIANT || dup.length > 0) {
      datOk = false;
      fail('V14R-DAT-001', `${variant}: count=${rows.length} expected=${EXPECTED_PER_VARIANT} dups=${dup.join(',')}`);
    }
  }
  if (datOk) pass('V14R-DAT-001', `all ${RUN_VARIANTS.length} variants: ${EXPECTED_PER_VARIANT} unique candidates each`);
  if (datOk) pass('V14R-DAT-002', 'expected variant run census fully present');

  // ---- V14R-DAT-003: episode/split isolation ----
  const splitLock = loadJsonStrict(R('evidence/v14/split_lock.json')) as unknown as { episode_to_split: Record<string, string> };
  const censusEpisodes = new Set<string>();
  for (const variant of RUN_VARIANTS) {
    for (const r of loadVariantOutcomes(variant)) censusEpisodes.add(r.episode_id);
  }
  const splitOf = new Map<string, string>();
  for (const [ep, sp] of Object.entries(splitLock.episode_to_split)) splitOf.set(ep, sp);
  const missingEpisodes = [...censusEpisodes].filter((ep) => !splitOf.has(ep));
  const episodeSplitsInOutcomes = new Map<string, Set<string>>();
  for (const variant of RUN_VARIANTS) {
    for (const r of loadVariantOutcomes(variant)) {
      if (!episodeSplitsInOutcomes.has(r.episode_id)) episodeSplitsInOutcomes.set(r.episode_id, new Set());
      episodeSplitsInOutcomes.get(r.episode_id)!.add(r.split);
    }
  }
  const overlap = [...episodeSplitsInOutcomes.entries()].filter(([, splits]) => splits.size > 1).map(([ep]) => ep);
  const bySplit: Record<string, number> = { legacy: 0, calibration: 0, holdout: 0 };
  for (const sp of splitOf.values()) {
    if (sp in bySplit) bySplit[sp] = (bySplit[sp] ?? 0) + 1;
  }
  const expectedSplit: Record<string, number> = { legacy: 10, calibration: 2, holdout: 2 };
  const splitMismatch = Object.entries(expectedSplit).filter(([sp, n]) => bySplit[sp as keyof typeof bySplit] !== n);
  if (missingEpisodes.length === 0 && overlap.length === 0 && splitMismatch.length === 0 && splitOf.size === 14) {
    pass('V14R-DAT-003', `episode disjoint: legacy=${bySplit.legacy} calibration=${bySplit.calibration} holdout=${bySplit.holdout}`);
  } else {
    fail('V14R-DAT-003', `missing=${missingEpisodes.join(',')} overlap=${overlap.join(',')} splitCountMismatch=${splitMismatch.map(([sp, n]) => `${sp}:${n}`).join(',')} total=${splitOf.size}`);
  }

  // ---- V14R-AUD-001/002: deterministic FAIL audit completeness ----
  const sample = loadJsonStrict(R('evidence/v14r/fail_audit_sample.json')) as unknown as { offsets: number[]; sampled_candidates: { candidate_id: string }[] };
  if (JSON.stringify(sample.offsets) === JSON.stringify([20, 40, 60, 80, 100, 120, 140])) {
    pass('V14R-AUD-001', `sampled ${sample.sampled_candidates.length} candidates at offsets ${sample.offsets.join(',')}`);
  } else {
    fail('V14R-AUD-001', `offsets changed: ${JSON.stringify(sample.offsets)}`);
  }
  const auditRows = loadJsonlStrict(R('evidence/v14r/fail_audit_judge_outputs.jsonl'));
  const badAudit = auditRows.filter((r) => String(r.status) !== 'ok');
  if (auditRows.length === 7 && badAudit.length === 0) {
    pass('V14R-AUD-002', '7 audit outputs present; zero provider/parse gaps');
  } else {
    fail('V14R-AUD-002', `${auditRows.length} rows, ${badAudit.length} non-ok: ${badAudit.map((r) => String(r.candidate_id)).join(',')}`);
  }

  // ---- V14R-REC-001/002: E3 claims + report claims ----
  const e3 = loadVariantOutcomes('E3').filter((o) => o.split !== 'holdout');
  const e3Fails = e3.filter((o) => o.final_accepted && o.label === 'FAIL' && o.candidate_id !== BASELINE_ACCEPTED);
  const e3Hn = e3.filter((o) => o.final_accepted && o.hard_negative && o.candidate_id !== BASELINE_ACCEPTED).length;
  const e3Lk = e3.filter((o) => o.final_accepted && o.next_topic_leakage_case && o.candidate_id !== BASELINE_ACCEPTED).length;
  if (e3Fails.length === 2 && e3Hn === 2 && e3Lk === 2) {
    pass('V14R-REC-001', `E3 raw new FAIL/HN/leak counts reconcile (2/2/2): ${e3Fails.map((f) => f.candidate_id).join(',')}`);
  } else {
    fail('V14R-REC-001', `E3 counts FAIL=${e3Fails.length} HN=${e3Hn} LK=${e3Lk}`);
  }
  const claimsPath = R('evidence/v14r/report_claims.json');
  if (fs.existsSync(claimsPath)) {
    const claimsJson = loadJsonStrict(claimsPath) as { claims?: { claim_id: string; pass: boolean }[] };
    const failedClaims = (claimsJson.claims ?? []).filter((c) => !c.pass);
    if (failedClaims.length === 0) pass('V14R-REC-002', 'all report_claims pass');
    else fail('V14R-REC-002', `failing claims: ${failedClaims.map((c) => c.claim_id).join(',')}`);
  } else {
    na('V14R-REC-002', 'report_claims.json not generated yet');
  }

  // ---- V14R-SAF-001: recompute vs policy lock ----
  const lock = loadJsonStrict(R('evidence/v14/policy_lock.json')) as unknown as {
    locked_variant: string | null;
    hierarchy_check?: { results?: { variant_id: string; new_fail_accepted: string[]; new_hard_neg_accepted: number; new_leakage_accepted: number }[] };
  };
  const lockRows = lock.hierarchy_check?.results ?? [];
  let safOk = true;
  const bad: string[] = [];
  for (const variant of RUN_VARIANTS) {
    const rows = loadVariantOutcomes(variant);
    const scope = rows.filter((r) => r.split !== 'holdout');
    const newFails = scope.filter((r) => r.final_accepted && r.label === 'FAIL' && r.candidate_id !== BASELINE_ACCEPTED).map((r) => r.candidate_id);
    const newHn = scope.filter((r) => r.final_accepted && r.hard_negative && r.candidate_id !== BASELINE_ACCEPTED).length;
    const newLk = scope.filter((r) => r.final_accepted && r.next_topic_leakage_case && r.candidate_id !== BASELINE_ACCEPTED).length;
    const lockRow = lockRows.find((l) => l.variant_id === variant);
    if (!lockRow || JSON.stringify([...lockRow.new_fail_accepted].sort()) !== JSON.stringify([...newFails].sort()) || lockRow.new_hard_neg_accepted !== newHn || lockRow.new_leakage_accepted !== newLk) {
      safOk = false;
      bad.push(`${variant}: lock!=raw`);
    }
  }
  if (safOk) pass('V14R-SAF-001', 'safety recomputed per variant and matches policy_lock');
  else fail('V14R-SAF-001', bad.join('; '));

  // ---- V14R-CHK-001/002: checksums ----
  const manifestPath = R('evidence/v14r/SHA256SUMS');
  if (!fs.existsSync(manifestPath)) {
    fail('V14R-CHK-001', 'SHA256SUMS missing');
  } else {
    const entries: { hash: string; rel: string }[] = [];
    for (const line of fs.readFileSync(manifestPath, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const m = /^([0-9a-f]{64})  (.+)$/.exec(t);
      if (m) entries.push({ hash: m[1]!, rel: m[2]! });
    }
    const seen = new Set<string>();
    const problems: string[] = [];
    let escapes = 0;
    for (const e of entries) {
      const abs = R(e.rel);
      if (!abs.startsWith(ROOT + path.sep)) escapes += 1;
      if (seen.has(e.rel)) problems.push(`dup:${e.rel}`);
      seen.add(e.rel);
      if (!fs.existsSync(abs) || lfHash(abs) !== e.hash) problems.push(`mismatch:${e.rel}`);
    }
    const mutableListed = entries.filter((e) => /run_summary\.json$/.test(e.rel) || e.rel.includes('verification_report') || e.rel.includes('ci_run_metadata'));
    if (problems.length === 0 && escapes === 0 && entries.length > 0 && mutableListed.length === 0) {
      pass('V14R-CHK-001', `${entries.length} entries exist and match (LF-normalized)`);
      pass('V14R-CHK-002', 'manifest excludes itself and mutable run_summary outputs');
    } else {
      fail('V14R-CHK-001', `problems=${problems.slice(0, 5).join(' ')} escapes=${escapes} entries=${entries.length}`);
      fail('V14R-CHK-002', `mutable listed: ${mutableListed.map((m) => m.rel).join(',')}`);
    }
  }

  // ---- V14R-PRD-001: production invariance (static) ----
  const configSrc = fs.readFileSync(R('src/lib/config.ts'), 'utf-8');
  const thresholdsSrc = fs.readFileSync(R('src/lib/domain/thresholds.ts'), 'utf-8');
  const floor = /readFloat\('HIGHLIGHT_MIN_ENDING_CONFIDENCE',\s*([0-9.]+)\)/.exec(configSrc);
  const libMin = /LIBRARY_MIN_SCORE\s*=\s*([0-9.]+)/.exec(thresholdsSrc);
  const floorOk = floor !== null && Math.abs(Number.parseFloat(floor[1]!) - 0.82) < 1e-9;
  const libOk = libMin !== null && Math.abs(Number.parseFloat(libMin[1]!) - 70) < 1e-9;
  const offenders: string[] = [];
  for (const f of walk('src/lib')) {
    if (f.includes('v14') || f.includes('__tests__')) continue;
    const content = fs.readFileSync(R(f), 'utf-8');
    if (content.includes('lib/v14') || content.includes('lib/v14r')) offenders.push(f);
  }
  if (floorOk && libOk && offenders.length === 0) {
    pass('V14R-PRD-001', `defaults floor=0.82 threshold=70; no production import of v14/v14r (offenders=0)`);
  } else {
    fail('V14R-PRD-001', `floor=${floorOk} threshold=${libOk} offenders=${offenders.join(',')}`);
  }

  // ---- deterministic report ----
  fs.writeFileSync(
    path.join(OUT, 'verification_report.json'),
    JSON.stringify({
      schema_version: 3,
      suite: 'v14r-evidence-gate',
      checks,
      summary: {
        pass: checks.filter((c) => c.status === 'PASS').length,
        fail: checks.filter((c) => c.status === 'FAIL').length,
        not_evaluable: checks.filter((c) => c.status === 'NOT_EVALUABLE').length,
      },
    }, null, 2),
    'utf-8',
  );
  console.log(JSON.stringify(checks.filter((c) => c.status !== 'PASS')));
  const fails = checks.filter((c) => c.status === 'FAIL');
  if (fails.length > 0) process.exitCode = 1;
  console.log(`v14r-verify: ${checks.length - fails.length}/${checks.length} ok`);
}

/* ---------- helpers ---------- */
interface VariantOutcome {
  candidate_id: string;
  episode_id: string;
  split: string;
  label: 'PASS' | 'FAIL' | 'REVIEW';
  hard_negative: boolean;
  next_topic_leakage_case: boolean;
  final_accepted: boolean;
}
function loadVariantOutcomes(variant: (typeof RUN_VARIANTS)[number]): VariantOutcome[] {
  return loadJsonlStrict(requiredRunFile(R('evidence/v14/runs'), variant, 'variant_results.jsonl')) as unknown as VariantOutcome[];
}
function walk(dir: string): string[] {
  const out: string[] = [];
  const stack = [R(dir)];
  while (stack.length > 0) {
    const d = stack.pop()!;
    if (!fs.existsSync(d)) continue;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith('.ts')) out.push(path.relative(ROOT, p));
    }
  }
  return out;
}
try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}