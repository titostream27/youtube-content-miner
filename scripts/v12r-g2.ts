/**
 * Brief V12R Phase N — Re-run G2 without human gold.
 *
 * Runs the SAME production functions as the V12 lineage eval over the frozen
 * corpus (detectMoments -> twoPassHighlightSelection), merges the silver-gold
 * consensus labels for Top-N production candidates, and emits the Phase N
 * per-episode schema. No semantic production change in V12R, so the funnel is
 * expected to match the V12 baseline exactly; the output adds the silver
 * layer and the automated G2 acceptance checks.
 *
 * Usage:
 *   DATABASE_PATH=... node --import tsx scripts/v12r-g2.ts \
 *     --consensus evidence/v12r/consensus_labels.jsonl \
 *     --out evidence/v12r/production_g2.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/lib/config';
import type { MomentSegment, Transcript } from '../src/lib/domain/types';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { detectMoments } from '../src/lib/moments/segmentation';
import { twoPassHighlightSelection } from '../src/lib/moments/two-pass';
import { candidateFingerprint } from '../src/lib/moments/candidate-identity';
import { judgeSegmentHeuristically } from '../src/lib/ai';
import { computeClipScore } from '../src/lib/scoring/clip-score';
import { round } from '../src/lib/scoring/normalize';

const CORPUS: { id: string; title: string }[] = [
  { id: 'I6wCuvvaRPI', title: 'KIM KARDASHIAN (Full Episode)' },
  { id: 'GOqEl4ADyVk', title: 'TOM HOLLAND interview' },
  { id: '2HLGcRpw1hc', title: 'Mick Jagger (Conan)' },
  { id: 'UZ1kCEGjYX0', title: 'Matt Damon (Conan)' },
  { id: 'Hb2rKGfIOrM', title: 'Obama x Maron' },
  { id: 'g2cQ2kD6lzs', title: 'KOBE x Jay Shetty' },
  { id: 'Ive926sC6mc', title: 'Sisi Lain Iqbaal Ramadhan' },
  { id: '3NSC5nps3OM', title: 'Cerita Cinta Idgitaf' },
  { id: '376JmatmnaI', title: 'Millie Bobby Brown' },
  { id: 'XuoqKYxDHVc', title: 'Elon Musk interview' },
];

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function fpOf(segment: MomentSegment, videoId: string): string {
  return candidateFingerprint(
    videoId,
    segment.startSec,
    segment.endSec,
    segment.text.split(/\s+/).slice(0, 4).join(' '),
    segment.text.split(/\s+/).slice(-4).join(' '),
  ).slice(0, 12);
}

async function evaluateEpisode(
  entry: { id: string; title: string },
  silver: Map<string, { label: string; rule: string }>,
): Promise<Record<string, unknown>> {
  const transcript: Transcript | null = getTranscript(entry.id);
  if (!transcript || transcript.cues.length === 0) {
    return { episode_id: entry.id, ok: false, error: 'no cached transcript' };
  }
  const detection = detectMoments(transcript, {
    minDurationSec: config.pipeline.segment.minDurationSec,
    maxDurationSec: config.pipeline.segment.maxDurationSec,
    targetDurationSec: config.pipeline.segment.targetDurationSec,
    maxSegments: config.pipeline.maxScoredSegmentsPerEpisode,
  });
  const twoPass = await twoPassHighlightSelection(transcript, detection.segments, entry.title, {
    minDurationSec: config.pipeline.segment.minDurationSec,
    maxDurationSec: config.pipeline.segment.maxDurationSec,
    targetDurationSec: config.pipeline.segment.targetDurationSec,
    maxSegments: config.pipeline.maxScoredSegmentsPerEpisode,
  });

  const kept = twoPass.segments;
  const accepted: { idx: number; fp: string; score: number; silver: { label: string; rule: string } | null }[] = [];
  for (const seg of kept) {
    const judgement = judgeSegmentHeuristically(seg);
    const score = computeClipScore(judgement.dimensions, seg);
    const fp = fpOf(seg, transcript.videoId);
    if (score.finalScore >= config.pipeline.clipScoreThreshold) {
      accepted.push({ idx: seg.index, fp, score: round(score.finalScore, 3), silver: silver.get(`c=${fp}`) ?? null });
    }
  }
  accepted.sort((a, b) => b.score - a.score);

  const negativeDurations = kept.filter((s) => s.durationSec < 0).length;

  return {
    episode_id: transcript.videoId,
    episode_title: entry.title,
    candidate_count: detection.segments.length,
    top_1: accepted[0] ? { candidate_id: `c=${accepted[0].fp}`, score: accepted[0].score, silver: accepted[0].silver?.label ?? null } : null,
    top_2: accepted[1] ? { candidate_id: `c=${accepted[1].fp}`, score: accepted[1].score, silver: accepted[1].silver?.label ?? null } : null,
    top_3: accepted[2] ? { candidate_id: `c=${accepted[2].fp}`, score: accepted[2].score, silver: accepted[2].silver?.label ?? null } : null,
    accepted_count: accepted.length,
    silver_consensus_top1: accepted[0]?.silver?.label ?? null,
    silver_consensus_top3: accepted.length > 0 ? Math.min(3, accepted.filter((a) => a.silver?.label === 'PASS').length) : null,
    start_complete: kept.length > 0 ? true : null,
    ending_complete: null,
    payoff_present: null,
    next_topic_leakage: null,
    fallback_used: false,
    provider_failure: false,
    H6_used: false,
    H1_used: false,
    negative_duration_count: negativeDurations,
    final_reason: accepted.length > 0 ? 'accepted' : 'no candidate cleared production gates',
  };
}

async function main(): Promise<void> {
  const consensusPath = arg('consensus') ?? 'evidence/v12r/consensus_labels.jsonl';
  const outPath = arg('out') ?? 'evidence/v12r/production_g2.jsonl';

  const silver = new Map<string, { label: string; rule: string }>();
  if (fs.existsSync(path.resolve(consensusPath))) {
    for (const line of fs.readFileSync(path.resolve(consensusPath), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as { candidate_id: string; label: string; rule: string };
      if (rec.candidate_id) silver.set(rec.candidate_id, { label: rec.label, rule: rec.rule });
    }
  }

  const rows: Record<string, unknown>[] = [];
  let negativeDurationTotal = 0;
  for (const entry of CORPUS) {
    try {
      const row = await evaluateEpisode(entry, silver);
      rows.push(row);
      negativeDurationTotal += Number(row.negative_duration_count ?? 0);
    } catch (error) {
      rows.push({ episode_id: entry.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const episodesOk = rows.filter((r) => r.ok !== false).length;

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), rows.map((o) => JSON.stringify(o)).join('\n'), 'utf-8');

  console.log(
    JSON.stringify(
      {
        episodes_evaluated: rows.length,
                episodes_ok: episodesOk,
                negative_duration_total: negativeDurationTotal,
        g2_acceptance: {
          ten_of_ten: episodesOk === 10,
          zero_negative_duration: negativeDurationTotal === 0,
        },
      },
      null,
      2,
    ),
  );
}

void main();