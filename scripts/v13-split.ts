/**
 * Brief V13 Phase G — Episode-disjoint calibration/holdout split.
 *
 * Deterministic split by EPISODE (never by candidate) so near-duplicate
 * candidates from one episode can't leak across partitions:
 *   bucket = hash(episode_id + ":" + benchmark_version) % 100
 *   bucket < 70 -> CALIBRATION, else HOLDOUT
 * If class balance is invalid (no silver PASS in one partition), falls back
 * to leave-one-episode-out (documented in the manifest).
 *
 * Usage:
 *   node --import tsx scripts/v13-split.ts \
 *     --labels evidence/v13/consensus_labels_v13.jsonl \
 *     --out evidence/v13/split_manifest.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface LabelRow {
  candidate_id: string;
  episode_id: string;
  label: string;
}

function main(): void {
  const labelsPath = arg('labels') ?? 'evidence/v13/consensus_labels_v13.jsonl';
  const outPath = arg('out') ?? 'evidence/v13/split_manifest.json';
  const version = process.env.V13_BENCHMARK_VERSION?.trim() || 'v13.0';

  const rows: LabelRow[] = fs
    .readFileSync(path.resolve(labelsPath), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LabelRow);

  const episodes = Array.from(new Set(rows.map((r) => r.episode_id))).sort();
  const bucketOf = (ep: string): number => {
    const digest = crypto.createHash('sha256').update(`${ep}:${version}`).digest('hex');
    return Number.parseInt(digest.slice(0, 6), 16) % 100;
  };

  const calibration = episodes.filter((ep) => bucketOf(ep) < 70);
  const holdout = episodes.filter((ep) => bucketOf(ep) >= 70);

  const passOf = (eps: string[]): number =>
    rows.filter((r) => eps.includes(r.episode_id) && r.label === 'PASS').length;

  const calPass = passOf(calibration);
  const holdPass = passOf(holdout);
  const calibInvalid = calPass === 0 || holdPass === 0;

  const manifest = {
    strategy: calibInvalid ? 'leave-one-episode-out' : 'hash-episode-70/30',
    benchmark_version: version,
    split_before_tuning: true,
    calibration_episodes: calibInvalid ? [] : calibration,
    holdout_episodes: calibInvalid ? [] : holdout,
    calibration_episode_count: calibInvalid ? 0 : calibration.length,
    holdout_episode_count: calibInvalid ? 0 : holdout.length,
    calibration_pass_count: calibInvalid ? null : calPass,
    holdout_pass_count: calibInvalid ? null : holdPass,
    fallback_reason: calibInvalid
      ? `class balance invalid (calibration PASS=${calPass}, holdout PASS=${holdPass}) — use leave-one-episode-out and document why`
      : null,
    leave_one_episode_out: calibInvalid
      ? episodes.map((ep) => ({
          episode_id: ep,
          evaluation_episode: ep,
          training_episodes: episodes.filter((e) => e !== ep),
          training_pass_count: passOf(episodes.filter((e) => e !== ep)),
        }))
      : null,
    episodes_total: episodes.length,
    candidates_total: rows.length,
    pass_total: rows.filter((r) => r.label === 'PASS').length,
  };

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(JSON.stringify({ wrote: outPath, ...manifest }, null, 2));
}


main();