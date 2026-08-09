/**
 * Brief V13 Phase H — Gate-level counterfactual ablation.
 *
 * For every candidate and every suspicious stage, replay the candidate with
 * ONLY that stage bypassed (all downstream stages stay active) and record:
 *   current_decision / counterfactual_decision / silver_label /
 *   would_recover_positive? / would_promote_negative? / downstream_result
 *
 * Runs on CALIBRATION episodes first (the split manifest decides which
 * episodes are calibration). Output: evidence/v13/counterfactuals.jsonl and
 * evidence/v13/gate_ablation_summary.json.
 *
 * Usage:
 *   DATABASE_PATH=... node --import tsx scripts/v13-counterfactuals.ts \
 *     --lineage docs&#x2F;evidence&#x2F;v12-lineage.jsonl \
 *     --labels evidence/v13/consensus_labels_v13.jsonl \
 *     --split evidence/v13/split_manifest.json \
 *     --out-dir evidence/v13
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { traceCandidate, type StageName } from '../src/lib/v13r/trace';
import type { LineageRow } from '../src/lib/v12r/sampling';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BYPASS_CANDIDATES: StageName[] = [
  '03_START_GATE',
  '04_ENDING_COMPLETE',
  '05_ENDING_CONFIDENCE',
  '06_CONTAMINATION_GATE',
  '07_DURATION_GATE',
  '12_ACCEPTANCE_THRESHOLD',
];

/** Counterfactual threshold variants (small, evidence-backed moves only). */

function main(): void {
  const lineagePath = arg('--lineage') ?? 'docs/evidence/v12-lineage.jsonl';
  const labelsPath = arg('--labels') ?? 'evidence/v13/consensus_labels_v13.jsonl';
  const splitPath = arg('--split') ?? 'evidence/v13/split_manifest.json';
  const outDir = arg('--out-dir') ?? 'evidence/v13';

  const rows: LineageRow[] = fs
    .readFileSync(path.resolve(lineagePath), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LineageRow)
    .filter((r) => r.candidate_id);

  const labels = new Map<string, string>();
  if (fs.existsSync(path.resolve(labelsPath))) {
    for (const line of fs.readFileSync(path.resolve(labelsPath), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as { candidate_id?: string; label?: string };
      if (rec.candidate_id && rec.label) labels.set(rec.candidate_id, rec.label);
    }
  }

  // Calibration episodes (holdout remains untouched during tuning).
  let calibrationEpisodes: string[] | null = null;
  if (fs.existsSync(path.resolve(splitPath))) {
    const split = JSON.parse(fs.readFileSync(path.resolve(splitPath), 'utf-8')) as {
      calibration_episodes?: string[];
      fallback_reason?: string | null;
    };
    // Fallback LOEO: use every episode except one reserved holdout is
    // impossible here; treat all episodes as calibration when split fell back.
    calibrationEpisodes = split.calibration_episodes ?? null;
  }
  const calibrate = (episodeId: string): boolean =>
    calibrationEpisodes === null ? true : calibrationEpisodes.includes(episodeId);

  const outLines: Record<string, unknown>[] = [];

  for (const row of rows) {
    if (!calibrate(row.episode_id!)) continue;
    const transcript = getTranscript(row.episode_id!);
    if (!transcript || transcript.cues.length === 0) continue;

    const baseline = traceCandidate(row, transcript);
    const silver = labels.get(row.candidate_id!) ?? 'NO_LABEL';

    for (const stage of BYPASS_CANDIDATES) {
      const cf = traceCandidate(row, transcript, { overrides: { bypass: new Set([stage]) } });
      const recoveredPositive = silver === 'PASS' && !baseline.final_accepted && cf.final_accepted;
      const promotedNegative = silver === 'FAIL' && !baseline.final_accepted && cf.final_accepted;
      outLines.push({
        candidate_id: row.candidate_id,
        episode_id: row.episode_id,
        stage_bypassed: stage,
        silver_label: silver,
        current_decision: baseline.final_accepted ? 'ACCEPTED' : `DIED_${baseline.first_death}`,
        counterfactual_decision: cf.final_accepted ? 'ACCEPTED' : `DIED_${cf.first_death}`,
        would_recover_positive: recoveredPositive,
        would_promote_negative: promotedNegative,
        downstream_first_death: cf.first_death,
        baseline_final_score: baseline.final_score,
        cf_final_score: cf.final_score,
        split: calibrate(row.episode_id!) ? 'calibration' : 'holdout',
      });
    }

    // Threshold variants (only meaningful for stages with thresholds).
    for (const variant of ALTERNATIVE_VARIANTS) {
      const v = variant.overrides as Record<string, number>;
      const cf = traceCandidate(row, transcript, { overrides: v });
      if (cf.final_accepted !== baseline.final_accepted) {
        outLines.push({
          candidate_id: row.candidate_id,
          episode_id: row.episode_id,
          variant: variant.name,
          silver_label: silver,
          current_decision: baseline.final_accepted ? 'ACCEPTED' : `DIED_${baseline.first_death}`,
          counterfactual_decision: cf.final_accepted ? 'ACCEPTED' : `DIED_${cf.first_death}`,
          would_recover_positive: silver === 'PASS' && !baseline.final_accepted && cf.final_accepted,
          would_promote_negative: silver === 'FAIL' && !baseline.final_accepted && cf.final_accepted,
          baseline_final_score: baseline.final_score,
          cf_final_score: cf.final_score,
        });
      }
    }
  }

  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  fs.writeFileSync(path.resolve(outDir, 'counterfactuals.jsonl'), outLines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');

  // ---- Summary: per-stage recovery vs leakage ----
  const byStage = new Map<string, { recovered: number; leaked: number; rows: number }>();
  for (const row2 of outLines) {
    if (!row2.stage_bypassed) continue;
    const stage = String(row2.stage_bypassed);
    const s = byStage.get(stage) ?? { recovered: 0, leaked: 0, rows: 0 };
    s.rows += 1;
    if (row2.would_recover_positive) s.recovered += 1;
    if (row2.would_promote_negative) s.leaked += 1;
    byStage.set(stage, s);
  }
  const summary = {
    candidates_ablated: rows.filter((r) => calibrate(r.episode_id!)).length,
    calibration_episode_strategy: calibrationEpisodes === null ? 'all-episodes (LOEO fallback)' : `episodes=${calibrationEpisodes.join(',')}`,
    per_stage: Object.fromEntries(byStage),
    notes: 'One gate bypassed at a time; all downstream stages active. Threshold variants tested: ' + ALTERNATIVE_VARIANTS.map((v) => v.name).join(', '),
  };
  fs.writeFileSync(path.resolve(outDir, 'gate_ablation_summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log(JSON.stringify(summary, null, 2));
}

const ALTERNATIVE_VARIANTS: { name: string; overrides: Record<string, number> }[] = [
  { name: 'ending_conf_0.80', overrides: { altEndingConfidence: 0.8 } },
  { name: 'ending_conf_0.78', overrides: { altEndingConfidence: 0.78 } },
  { name: 'contamination_0.25', overrides: { altMaxContamination: 0.25 } },
];

main();