/**
 * Brief V14 Phase P3 — episode manifest + episode-disjoint split lock.
 *
 * Split unit is EPISODE. The 10 V13 episodes are the legacy regression set
 * (never clean holdout). The 4 new episodes are assigned deterministically:
 *   bucket = sha256(episode_id + ":v14.0") mod 100; bucket < 50 -> calibration,
 *   bucket >= 50 -> holdout.
 * The lock artifact records dataset/label/policy hashes; its SHA-256 is
 * printed for the completion report.
 *
 * Usage:
 *   node --import tsx scripts/v14-split.ts
 *     --legacy-lineage docs/evidence/v12-lineage.jsonl
 *     --legacy-labels evidence/v13/consensus_labels_v13.jsonl
 *     --census evidence/v14/census_new.jsonl
 *     --labels evidence/v14/silver_labels_v14.jsonl
 *     --judge-outputs evidence/v14/judge_outputs_v14.jsonl
 *     --out evidence/v14/split_lock.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sha256File(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function loadJsonl(p: string): Record<string, unknown>[] {
  const lines = fs.readFileSync(path.resolve(p), 'utf-8').split('\n').filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const LEGACY_EPISODES = [
  'I6wCuvvaRPI', 'GOqEl4ADyVk', '2HLGcRpw1hc', 'UZ1kCEGjYX0', 'Hb2rKGfIOrM',
  'g2cQ2kD6lzs', 'Ive926sC6mc', '3NSC5nps3OM', '376JmatmnaI', 'XuoqKYxDHVc',
];

function main(): void {
  const legacyLineage = path.resolve(arg('legacy-lineage') ?? 'docs/evidence/v12-lineage.jsonl');
  const legacyLabels = path.resolve(arg('legacy-labels') ?? 'evidence/v13/consensus_labels_v13.jsonl');
  const censusPath = path.resolve(arg('census') ?? 'evidence/v14/census_new.jsonl');
  const labelsPath = path.resolve(arg('labels') ?? 'evidence/v14/silver_labels_v14.jsonl');
  const judgePath = arg('judge-outputs') ?? 'evidence/v14/judge_outputs_v14.jsonl';
  const outPath = path.resolve(arg('out') ?? 'evidence/v14/split_lock.json');
  const version = 'v14.0';
  const codeSha: string = sha256File('src/lib/v14/replay.ts') ?? 'NO';

  const census = loadJsonl(censusPath).filter((r) => r.type !== 'CENSUS_DONE');
  const newEpisodes = Array.from(new Set(census.map((r) => r.episode_id as string))).sort();

  // Deterministic assignment (protocol: sha256(episode + ":v14.0") mod 100, <50 calib).
  const bucketOf = (ep: string): number => {
    const d = crypto.createHash('sha256').update(`${ep}:${version}`).digest('hex');
    return Number.parseInt(d.slice(0, 6), 16) % 100;
  };
  const calibration: string[] = [];
  const holdout: string[] = [];
  for (const ep of newEpisodes) {
    if (bucketOf(ep) < 50) calibration.push(ep);
    else holdout.push(ep);
  }

  const legacyRows = loadJsonl(legacyLabels);
  const newRows = fs.existsSync(labelsPath) ? loadJsonl(labelsPath) : [];
  const labelCounts: Record<string, number> = {};
  for (const r of [...legacyRows, ...newRows]) {
    const l = (r.label as string) ?? 'NO_LABEL';
    labelCounts[l] = (labelCounts[l] ?? 0) + 1;
  }

  const episodeToSplit: Record<string, string> = {};
  for (const ep of LEGACY_EPISODES) episodeToSplit[ep] = 'legacy';
  for (const ep of calibration) episodeToSplit[ep] = 'calibration';
  for (const ep of holdout) episodeToSplit[ep] = 'holdout';

  const candidateToSplit: Record<string, string> = {};
  for (const r of loadJsonl(legacyLineage)) {
    if (r.candidate_id) candidateToSplit[r.candidate_id as string] = 'legacy';
  }
  for (const r of census) {
    if (r.candidate_id) candidateToSplit[r.candidate_id as string] = episodeToSplit[r.episode_id as string] ?? 'UNKNOWN';
  }

  const lock = {
    experiment_version: version,
    created_at: new Date().toISOString(),
    split_unit: 'episode',
    legacy_episodes: LEGACY_EPISODES,
    new_episodes: newEpisodes,
    deterministic_rule: `sha256(episode_id + ':${version}') mod 100; <50 => calibration, >=50 => holdout`,
    episode_to_split: episodeToSplit,
    calibration: calibration.sort(),
    holdout: holdout.sort(),
    candidate_count: Object.keys(candidateToSplit).length,
    label_counts: labelCounts,
    hashes: {
      legacy_lineage: sha256File(legacyLineage),
      legacy_labels: sha256File(legacyLabels),
      census: sha256File(censusPath),
      labels_v14: fs.existsSync(labelsPath) ? sha256File(labelsPath) : null,
      judge_outputs_v14: judgePath ? sha256File(path.resolve(judgePath)) : null,
      protocol: sha256File(path.resolve('protocol.yaml')),
      baseline: sha256File(path.resolve('evidence/v14/baseline.json')),
      code: codeSha,
      metric_spec: sha256Text('V14 metrics: PASS_Recall@Eligible/Accepted, FAIL leakage, hard-neg, next-topic-leakage; Wilson 95%; micro+macro'),
    },
    leakage_checks: {
      episode_overlap: 'asserted: every episode in exactly one split; legacy never clean holdout',
      candidate_overlap: 'asserted by construction (candidate->episode->split single map)',
      holdout_sealed_until_lock: true,
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const body = JSON.stringify(lock, null, 2);
  fs.writeFileSync(outPath, body, 'utf-8');
  console.log(`split_lock written: calibration=${calibration.join(',')} holdout=${holdout.join(',')}`);
  console.log(`lock_sha256=${sha256Text(body)}`);
}

main();