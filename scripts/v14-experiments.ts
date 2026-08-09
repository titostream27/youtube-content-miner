/**
 * Brief V14 Phase P4/P5 — offline experiment runner (variant replay).
 *
 * Usage:
 *   DATABASE_PATH=... node --env-file=... --import tsx scripts/v14-experiments.ts \
 *     --variant E3 --splits legacy,calibration --tag e3
 *
 * Variants: C0 E1 E2 E3 E4 S1 S2 Q1 T1 NEGATIVE_CONTROL (T1 requires --threshold-grid)
 * Flags: --golden (C0 vs V13 control), --det-check (double run byte compare)
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import type { Transcript } from '../src/lib/domain/types';
import type { LineageRow } from '../src/lib/v12r/sampling';
import { replayCandidateV14 } from '../src/lib/v14/replay';
import type { V14ReplayResult } from '../src/lib/v14/replay-helpers';
import { VARIANT_POLICIES, type EndingVariantId } from '../src/lib/v14/ending-policy';
import { computeRates, policySwitchRows, type MetricRow, type OutcomeLike, type Label } from '../src/lib/v14/metrics';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface CandidateRow {
  candidate_id: string;
  episode_id: string;
  lineage: LineageRow;
  label: Label;
  hard_negative: boolean;
  next_topic_leakage_case: boolean;
  split: string;
}

const LEGACY_LABELS = 'evidence/v13/consensus_labels_v13.jsonl';
const LEGACY_LINEAGE = 'docs/evidence/v12-lineage.jsonl';
const LEGACY_JUDGE = 'evidence/v13/judge_outputs.jsonl';
const CENSUS = 'evidence/v14/census_new.jsonl';
const V14_LABELS = 'evidence/v14/silver_labels_v14.jsonl';
const V14_JUDGE = 'evidence/v14/judge_outputs_v14.jsonl';
const SPLIT_LOCK = 'evidence/v14/split_lock.json';

function loadJsonl(p: string): Record<string, unknown>[] {
  const abs = path.resolve(p);
  return fs.existsSync(abs)
    ? fs.readFileSync(abs, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
}

function loadSplit(): Record<string, string> {
  const p = path.resolve(SPLIT_LOCK);
  if (!fs.existsSync(p)) return {};
  const lock = JSON.parse(fs.readFileSync(p, 'utf-8')) as { episode_to_split: Record<string, string>; calibration: string[]; holdout: string[] };
  const map: Record<string, string> = { ...lock.episode_to_split };
  return map;
}

/** Judge-derived safety classes (any content verdict flag). */
function loadFlags(judgePaths: string[]): { hardNeg: Set<string>; nextLeak: Set<string> } {
  const hardNeg = new Set<string>();
  const nextLeak = new Set<string>();
  for (const p of judgePaths) {
    for (const row of loadJsonl(p)) {
      const out = (row.output as Record<string, unknown> | null) ?? null;
      if (!out) continue;
      if (out.hard_negative === true) hardNeg.add(row.candidate_id as string);
      if (out.next_topic_leakage === true) nextLeak.add(row.candidate_id as string);
    }
  }
  return { hardNeg, nextLeak };
}

/** Build the full registry (legacy + new census candidates) with labels & splits. */
export function buildRegistry(): { candidates: CandidateRow[]; splitMap: Record<string, string> } {
  const splitMap = loadSplit();
  const labels = new Map<string, string>();
  for (const r of loadJsonl(LEGACY_LABELS)) labels.set(r.candidate_id as string, r.label as string);
  for (const r of loadJsonl(V14_LABELS)) labels.set(r.candidate_id as string, r.label as string);
  const { hardNeg, nextLeak } = loadFlags([LEGACY_JUDGE, V14_JUDGE]);

  const candidates: CandidateRow[] = [];
  for (const r of loadJsonl(LEGACY_LINEAGE)) {
    const id = r.candidate_id as string;
    if (!id) continue;
    candidates.push({
      candidate_id: id,
      episode_id: r.episode_id as string,
      lineage: r as unknown as LineageRow,
      label: (labels.get(id) ?? 'NO_LABEL') as Label,
      hard_negative: hardNeg.has(id),
      next_topic_leakage_case: nextLeak.has(id),
      split: 'legacy',
    });
  }
  for (const r of loadJsonl(CENSUS)) {
    const id = r.candidate_id as string;
    if (!id || r.type === 'CENSUS_DONE') continue;
    const ep = r.episode_id as string;
    candidates.push({
      candidate_id: id,
      episode_id: ep,
      lineage: r as unknown as LineageRow,
      label: (labels.get(id) ?? 'NO_LABEL') as Label,
      hard_negative: hardNeg.has(id),
      next_topic_leakage_case: nextLeak.has(id),
      split: splitMap[ep] ?? 'UNKNOWN',
    });
  }
  return { candidates, splitMap };
}

export function transcriptFor(episodeId: string): Transcript | null {
  return getTranscript(episodeId);
}

/* __RUNNER__ */

/** Variant -> run options (production semantics untouched; all offline). */
function optionsFor(
  variant: string,
  threshold?: number,
): { endingVariant: EndingVariantId; startPenalty: number; clipThreshold: number; permissive: boolean } {
  switch (variant) {
    case 'C0':
      return { endingVariant: 'C0', startPenalty: 0, clipThreshold: threshold ?? 70, permissive: false };
    case 'E1':
      return { endingVariant: 'E1', startPenalty: 0, clipThreshold: threshold ?? 70, permissive: false };
    case 'E2':
      return { endingVariant: 'E2', startPenalty: 0, clipThreshold: threshold ?? 70, permissive: false };
    case 'E3':
    case 'S1':
    case 'Q1':
      return { endingVariant: 'E3', startPenalty: 0, clipThreshold: threshold ?? 70, permissive: false };
    case 'E4':
      return { endingVariant: 'E4', startPenalty: 0, clipThreshold: threshold ?? 70, permissive: false };
    case 'S2':
      return { endingVariant: 'E3', startPenalty: 2, clipThreshold: threshold ?? 70, permissive: false };
    case 'T1':
      return { endingVariant: 'E3', startPenalty: 0, clipThreshold: threshold ?? 70, permissive: false };
    case 'NEGATIVE_CONTROL':
      return { endingVariant: 'C0', startPenalty: 0, clipThreshold: 0, permissive: true };
    default:
      throw new Error(`unknown variant ${variant}`);
  }
}

/** Replay one candidate; returns outcome row for metrics + full result. */
function runCandidate(
  c: CandidateRow,
  variant: string,
  opts: ReturnType<typeof optionsFor>,
  transcript: Transcript,
): { outcome: OutcomeLike; result: V14ReplayResult } {
  const result = replayCandidateV14(c.lineage, transcript, {
    variant_id: variant,
    endingPolicy: VARIANT_POLICIES[opts.endingVariant],
    startUncertaintyPenalty: opts.startPenalty,
    clipThreshold: opts.clipThreshold,
    permissive: opts.permissive,
    seed: 'deterministic',
  });
  const outcome: OutcomeLike = {
    candidate_id: c.candidate_id,
    episode_id: c.episode_id,
    label: c.label,
    split: c.split,
    hard_negative: c.hard_negative,
    next_topic_leakage_case: c.next_topic_leakage_case,
    survived_to_scoring: result.survived_to_scoring,
    final_accepted: result.final_accepted,
    final_score: result.final_score,
    first_death: result.first_death ?? null,
    variant_id: variant,
  };
  return { outcome, result };
}

/** Flatten a replay into per-stage trace rows. */
function flattenStages(r: V14ReplayResult, c: CandidateRow): Record<string, unknown>[] {
  return r.stages.map((s) => ({
    run_id: r.run_id,
    parent_run_id: r.parent_run_id,
    candidate_id: r.candidate_id,
    episode_id: r.episode_id,
    variant_id: r.variant_id,
    split: c.split,
    label: c.label,
    stage_id: s.stage_id,
    stage_name: s.stage_name,
    execution_index: s.execution_index,
    reached: s.reached,
    bypassed: s.bypassed,
    status: s.status,
    semantic_state: s.semantic_state,
    raw_confidence: s.raw_confidence,
    observed_invalidity: s.observed_invalidity,
    action: s.action,
    reason_code: s.reason_code,
    evidence_refs: s.evidence_refs,
    evidence: s.evidence,
    score_before: s.score_before,
    delta: s.delta,
    score_after: s.score_after,
    first_death: r.first_death,
    explanation: s.explanation,
  }));
}

/* __MAIN__ */

function writeJsonl(p: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf-8');
}

function writeCsv(p: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    fs.writeFileSync(p, '', 'utf-8');
    return;
  }
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => { const v = r[c]; return v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`; }).join(','));
  }
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf-8');
}

/** V14-LEG-001/002: C0 replay vs recorded V13 control traces. */
function goldenCheck(outcomes: OutcomeLike[]): { ok: boolean; mismatches: string[]; pass_death: Record<string, number> } {
  const controlPath = path.resolve('evidence/v14/control_repro/traces.jsonl');
  const control = new Map<string, { first_death: string | null; final_accepted: boolean; final_score: number | null }>();
  if (fs.existsSync(controlPath)) {
    for (const line of fs.readFileSync(controlPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const d = JSON.parse(line) as { candidate_id: string; first_death: string | null; final_accepted: boolean; final_score: number | null };
      control.set(d.candidate_id, { first_death: d.first_death, final_accepted: d.final_accepted, final_score: d.final_score });
    }
  }
  const mismatches: string[] = [];
  const passDeath: Record<string, number> = {};
  for (const o of outcomes) {
    const ctrl = control.get(o.candidate_id);
    if (!ctrl) continue;
    if (o.first_death !== ctrl.first_death) mismatches.push(`${o.candidate_id}: first_death ${o.first_death} != recorded ${ctrl.first_death}`);
    if (o.final_accepted !== ctrl.final_accepted) mismatches.push(`${o.candidate_id}: accepted ${o.final_accepted} != recorded ${ctrl.final_accepted}`);
    if (o.final_score !== null && ctrl.final_score !== null && Math.abs(o.final_score - ctrl.final_score) > 0.001) {
      mismatches.push(`${o.candidate_id}: score ${o.final_score} != recorded ${ctrl.final_score}`);
    }
    if (o.label === 'PASS') {
      passDeath[o.first_death ?? 'SURVIVED'] = (passDeath[o.first_death ?? 'SURVIVED'] ?? 0) + 1;
    }
  }
  return { ok: mismatches.length === 0, mismatches, pass_death: passDeath };
}

function runScope(
  variant: string,
  selected: CandidateRow[],
  opts: ReturnType<typeof optionsFor>,
  variantId: string,
  transcriptCache: Map<string, Transcript | null>,
): { outcomes: OutcomeLike[]; stageRows: Record<string, unknown>[]; firstDeathRows: Record<string, unknown>[]; contribRows: Record<string, unknown>[] } {
  const outcomes: OutcomeLike[] = [];
  const stageRows: Record<string, unknown>[] = [];
  const firstDeathRows: Record<string, unknown>[] = [];
  const contribRows: Record<string, unknown>[] = [];
  for (const c of selected) {
    let tr = transcriptCache.get(c.episode_id);
    if (tr === undefined) {
      tr = getTranscript(c.episode_id);
      transcriptCache.set(c.episode_id, tr);
    }
    if (!tr) {
      outcomes.push({ candidate_id: c.candidate_id, episode_id: c.episode_id, label: c.label, split: c.split, hard_negative: c.hard_negative, next_topic_leakage_case: c.next_topic_leakage_case, survived_to_scoring: false, final_accepted: false, final_score: null, first_death: 'NO_TRANSCRIPT', variant_id: variantId });
      continue;
    }
    const { outcome, result } = runCandidate(c, variant, variantOpts(opts, variant), tr);
    outcomes.push(outcome);
    stageRows.push(...flattenStages(result, c));
    firstDeathRows.push({
      candidate_id: c.candidate_id,
      episode_id: c.episode_id,
      split: c.split,
      label: c.label,
      variant_id: variantId,
      first_death: result.first_death ?? 'SURVIVED',
      first_death_reason: result.first_death_reason,
      final_accepted: result.final_accepted,
      final_score: result.final_score,
    });
    for (const comp of result.score_contributions) {
      contribRows.push({ candidate_id: c.candidate_id, episode_id: c.episode_id, variant_id: variantId, component: comp.component, delta: comp.delta, note: comp.note, final_score: result.final_score });
    }
  }
  return { outcomes, stageRows, firstDeathRows, contribRows };
}

function variantOpts(o: { endingVariant: EndingVariantId; startPenalty: number; clipThreshold: number; permissive: boolean }, variant: string): { endingVariant: EndingVariantId; startPenalty: number; clipThreshold: number; permissive: boolean } {
  if (variant === 'S2') return { endingVariant: 'E3', startPenalty: 2, clipThreshold: o.clipThreshold, permissive: false };
  if (variant === 'NEGATIVE_CONTROL') return { endingVariant: 'C0', startPenalty: 0, clipThreshold: 0, permissive: true };
  return o;
}

function main(): void {
  const variant = arg('variant') ?? 'C0';
  const splits = (arg('splits') ?? 'legacy,calibration').split(',').map((s) => s.trim()).filter(Boolean);
  const tag = arg('tag') ?? variant.toLowerCase();
  const thresholds = (arg('threshold-grid') ?? '').split(',').map((s) => Number.parseFloat(s.trim())).filter(Number.isFinite);
  const outBase = path.resolve(arg('out-dir') ?? `evidence/v14/runs/${tag}`);
  const checkGolden = hasFlag('golden');
  const checkDet = hasFlag('det-check');
  const scopeVariants = variant === 'T1' && thresholds.length > 0
    ? thresholds.map((t) => ({ id: `T1@${t}`, threshold: t }))
    : [{ id: variant, threshold: undefined as number | undefined }];

  const { candidates } = buildRegistry();
  const selected = candidates.filter((c) => splits.includes(c.split));
  if (selected.length === 0) {
    console.error('no candidates for splits', splits);
    process.exit(2);
  }

  const transcriptCache = new Map<string, Transcript | null>();
  const allOutcomes: OutcomeLike[] = [];
  for (const run of scopeVariants) {
    const dir = path.join(outBase, run.id);
    fs.mkdirSync(dir, { recursive: true });
    const opts = optionsFor(variant, run.threshold);
    const first = runScope(variant, selected, opts, run.id, transcriptCache);
    allOutcomes.push(...first.outcomes);
    const metrics: MetricRow[] = [];
    for (const split of splits) metrics.push(...computeRates(first.outcomes, split));
    writeJsonl(path.join(dir, 'stage_trace.jsonl'), first.stageRows);
    writeCsv(path.join(dir, 'first_death.csv'), first.firstDeathRows);
    writeCsv(path.join(dir, 'score_contributions.csv'), first.contribRows);
    writeJsonl(path.join(dir, 'variant_results.jsonl'), first.outcomes as unknown as Record<string, unknown>[]);
    fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf-8');

    const summary: Record<string, unknown> = {
      variant_id: run.id,
      tag,
      splits,
      candidates: selected.length,
      written_at: new Date().toISOString(),
    };
    if (checkGolden && variant === 'C0') {
      const gc = goldenCheck(first.outcomes);
      summary.golden_check = { ok: gc.ok, mismatches: gc.mismatches, pass_death: gc.pass_death };
      if (!gc.ok) {
        console.error('GOLDEN MISMATCH', gc.mismatches.slice(0, 20));
        process.exitCode = 1;
      }
    }
    if (checkDet && variant === 'C0') {
      const second = runScope(variant, selected, opts, `${run.id}-DET2`, transcriptCache);
      const a = JSON.stringify(first.outcomes.map((o) => [o.candidate_id, o.final_accepted, o.first_death, o.final_score]));
      const b = JSON.stringify(second.outcomes.map((o) => [o.candidate_id, o.final_accepted, o.first_death, o.final_score]));
      summary.determinism_identical = a === b;
      if (a !== b) {
        console.error('DETERMINISM MISMATCH');
        process.exitCode = 1;
      }
    }
    fs.writeFileSync(path.join(dir, 'run_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`[v14] ${run.id}: ${first.outcomes.length} candidates -> ${dir}`);
  }

  // policy switches vs C0 (only when scope contains C0 results)
  const controlFile = path.join(outBase, 'C0', 'variant_results.jsonl');
  if (fs.existsSync(controlFile) && variant !== 'C0') {
    const control = fs.readFileSync(controlFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as OutcomeLike);
    const switches = policySwitchRows(control, allOutcomes);
    fs.mkdirSync(path.join(outBase, variant), { recursive: true });
    writeCsv(path.join(outBase, variant, 'policy_switches.csv'), switches as unknown as Record<string, unknown>[]);
    console.log(`[v14] policy_switches: ${switches.length}`);
  } else {
    fs.writeFileSync(path.join(outBase, 'policy_switches_note.txt'), 'policy switches computed against control in variant dirs', 'utf-8');
  }
}

main();