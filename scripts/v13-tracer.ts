/**
 * Brief V13 Phases D/E/F — Tracer cohorts, stage replay, first-death matrix,
 * stage metrics.
 *
 * Loads the lineage + V13 consensus labels, builds P/N/R tracer cohorts,
 * replays every candidate through the production stages (traceCandidate),
 * emits:
 *   evidence/v13/tracer_manifest.jsonl
 *   evidence/v13/traces.jsonl           (full stage-by-stage traces)
 *   evidence/v13/first_death_matrix.csv
 *   evidence/v13/stage_metrics.json
 *   evidence/v13/herd_suppression.jsonl (overlap lineage among survivors)
 *
 * Usage:
 *   DATABASE_PATH=... node --import tsx scripts/v13-tracer.ts \
 *     --lineage docs/evidence/v12-lineage.jsonl \
 *     --labels evidence/v13/consensus_labels_v13.jsonl \
 *     --out-dir evidence/v13
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { traceCandidate, TRACE_STAGES, type TraceResult } from '../src/lib/v13r/trace';
import type { LineageRow } from '../src/lib/v12r/sampling';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const lineagePath = arg('lineage') ?? 'docs/evidence/v12-lineage.jsonl';
  const labelsPath = arg('labels') ?? 'evidence/v13/consensus_labels_v13.jsonl';
  const outDir = arg('out-dir') ?? 'evidence/v13';

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

  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  const tracesPath = path.resolve(outDir, 'traces.jsonl');
  const tracerPath = path.resolve(outDir, 'tracer_manifest.jsonl');
  const matrixPath = path.resolve(outDir, 'first_death_matrix.csv');
  fs.writeFileSync(tracesPath, '', 'utf-8');
  fs.writeFileSync(tracerPath, '', 'utf-8');

  const labelOf = (t: TraceResult): string => labels.get(t.candidate_id) ?? 'NO_LABEL';
  const traces: TraceResult[] = [];
  const cohortCounts = { P: 0, N: 0, R: 0 };

  for (const row of rows) {
    const candidateId = row.candidate_id!;
    const label = labels.get(candidateId) ?? 'NO_LABEL';
    const transcript = getTranscript(row.episode_id!);
    if (!transcript || transcript.cues.length === 0) {
      fs.appendFileSync(
        tracerPath,
        `${JSON.stringify({ candidate_id: candidateId, episode_id: row.episode_id, silver_label: label, error: 'no transcript', repaired_variant: false })}\n`,
        'utf-8',
      );
      continue;
    }
    const trace = traceCandidate(row, transcript);
    traces.push(trace);
    if (label === 'PASS') cohortCounts.P += 1;
    else if (label === 'FAIL') cohortCounts.N += 1;
    else cohortCounts.R += 1;

    fs.appendFileSync(
      tracerPath,
      `${JSON.stringify({
        candidate_id: candidateId,
        episode_id: row.episode_id,
        silver_label: label,
        judge_confidence_summary: null,
        start_sec: row.final_start_sec ?? row.rough_start_sec ?? 0,
        end_sec: row.final_end_sec ?? row.rough_end_sec ?? 0,
        duration_sec: row.final_duration_sec ?? row.rough_duration_sec ?? null,
        original_production_rank: row.rank ?? null,
        original_failure_stage: row.rejection_stage ?? null,
        original_failure_reason: row.rejection_reason ?? null,
        production_final_score: row.final_score ?? null,
        lineage_source: row.proposal_source ?? 'unknown',
        repaired_variant: false,
      })}\n`,
      'utf-8',
    );
    fs.appendFileSync(tracesPath, JSON.stringify(trace) + '\n', 'utf-8');
  }

  // ---- Herd overlap suppression evidence (Phase M) ----
  const byEpisode = new Map<string, TraceResult[]>();
  for (const t of traces) {
    const list = byEpisode.get(t.episode_id) ?? [];
    list.push(t);
    byEpisode.set(t.episode_id, list);
  }
  const suppression: Record<string, unknown>[] = [];
  for (const [ep, list] of byEpisode) {
    for (const a of list) {
      for (const b of list) {
        if (a.candidate_id === b.candidate_id) continue;
        const overlap = Math.min(a.window.end_sec, b.window.end_sec) - Math.max(a.window.start_sec, b.window.start_sec);
        if (overlap > 1) {
          const aScore = a.final_score ?? -1;
          const bScore = b.final_score ?? -1;
          const aSuppressed = aScore <= bScore;
          suppression.push({
            episode_id: ep,
            suppressed_candidate_id: aSuppressed ? a.candidate_id : b.candidate_id,
            suppressed_by_candidate_id: aSuppressed ? b.candidate_id : a.candidate_id,
            overlap_sec: Math.round(overlap * 100) / 100,
            suppressed_silver: aSuppressed ? labelOf(a) : labelOf(b),
            suppressor_silver: aSuppressed ? labelOf(b) : labelOf(a),
          });
        }
      }
    }
  }
  fs.writeFileSync(path.resolve(outDir, 'herd_suppression.json'), JSON.stringify(suppression, null, 2), 'utf-8');

  // ---- First-death matrix CSV ----
  const header = [
    'candidate_id', 'episode_id', 'silver_label', 'first_death', 'first_death_reason',
    'survived_to_scoring', 'final_accepted', 'final_score', 'original_rejection_stage',
  ].join(',');
  const csvLines = [header];
  for (const t of traces) {
    csvLines.push([
      csv(t.candidate_id), t.episode_id, labelOf(t),
      t.first_death ?? 'SURVIVED', csv(t.first_death_reason ?? ''),
      t.survived_to_scoring ? 'yes' : 'no',
      t.final_accepted ? 'yes' : 'no',
      t.final_score ?? '',
      csv(t.original_rejection_stage ?? ''),
    ].join(','));
  }
  fs.writeFileSync(matrixPath, csvLines.join('\n'), 'utf-8');

  // ---- Stage metrics (Phase F §8.1) ----
  const passTraces = traces.filter((t) => labelOf(t) === 'PASS');
  const failTraces = traces.filter((t) => labelOf(t) === 'FAIL');

  const stageMetrics: Record<string, Record<string, number | null | Record<string, number>>> = {};
  for (const stage of TRACE_STAGES) {
    const passSurvived = passTraces.filter((t) => t.stages.some((s) => s.stage === stage && s.status === 'SURVIVED')).length;
    const failSurvived = failTraces.filter((t) => t.stages.some((s) => s.stage === stage && s.status === 'SURVIVED')).length;
    const passFirstDeath = passTraces.filter((t) => t.first_death === stage).length;
    const failFirstDeath = failTraces.filter((t) => t.first_death === stage).length;

    const passSurviveRate = passTraces.length > 0 ? passSurvived / passTraces.length : null;
    const failSurviveRate = failTraces.length > 0 ? failSurvived / failTraces.length : null;
    const passLostRate = passSurviveRate !== null ? 1 - passSurviveRate : null;
    const failRemovedRate = failSurviveRate !== null ? 1 - failSurviveRate : null;

    stageMetrics[stage] = {
      silver_pass_survival_rate: passSurviveRate,
      silver_fail_survival_rate: failSurviveRate,
      pass_first_death_count: passFirstDeath,
      pass_first_death_rate: passTraces.length > 0 ? passFirstDeath / passTraces.length : null,
      fail_first_death_count: failFirstDeath,
      // selectivity = negatives removed vs positives lost (higher = better gate)
      selectivity: passLostRate !== null && failRemovedRate !== null ? failRemovedRate - passLostRate : null,
      survive_count: { pass: passSurvived, fail: failSurvived },
      first_death_count: { pass: passFirstDeath, fail: failFirstDeath },
    };
  }

  const firstDeathDistribution = {
    pass: Object.fromEntries(TRACE_STAGES.map((s) => [s, passTraces.filter((t) => t.first_death === s).length])),
    fail: Object.fromEntries(TRACE_STAGES.map((s) => [s, failTraces.filter((t) => t.first_death === s).length])),
  };
  const perEpisode = Object.fromEntries(
    [...byEpisode.entries()].map(([ep, list]) => [
      ep,
      Object.fromEntries(TRACE_STAGES.map((s) => [s, list.filter((t) => labelOf(t) === 'PASS' && t.first_death === s).length])),
    ]),
  );

  fs.writeFileSync(path.resolve(outDir, 'stage_metrics.json'), JSON.stringify(stageMetrics, null, 2), 'utf-8');
  fs.writeFileSync(
    path.resolve(outDir, 'tracer_summary.json'),
    JSON.stringify(
      {
        candidates_traced: traces.length,
        cohort_counts: cohortCounts,
        first_death_distribution: firstDeathDistribution,
        per_episode_pass_first_death: perEpisode,
        stage_metrics: stageMetrics,
      },
      null,
      2,
    ),
    'utf-8',
  );

  const topPassDeaths = Object.entries(firstDeathDistribution.pass)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6)
    .map(([stage, count]) => ({ stage, pass_first_deaths: count }));

  console.log(
    JSON.stringify(
      {
        candidates_traced: traces.length,
        cohorts: cohortCounts,
        pass_traced: passTraces.length,
        fail_traced: failTraces.length,
        top_pass_death_stages: topPassDeaths,
        overlap_pairs: suppression.length,
      },
      null,
      2,
    ),
  );
}

function csv(v: string): string {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

main();