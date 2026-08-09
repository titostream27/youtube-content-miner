/**
 * Brief V13 Phase U — Production G2 re-run over the 10 frozen episodes.
 *
 * Runs the SAME production functions as the V12 lineage eval (detectMoments
 * -> twoPassHighlightSelection -> heuristic scoring -> clip threshold) and
 * merges the v13 hardened silver labels for Top-N production candidates.
 * The run is deterministic when AI_PROVIDER=heuristic (the same fallback
 * engine used by all V12/V12R production observations).
 *
 * Usage:
 *   DATABASE_PATH=... AI_PROVIDER=heuristic node --import tsx scripts/v13-g2.ts \
 *     --labels evidence/v13/consensus_labels_v13.jsonl \
 *     --out evidence/v13/production_g2.jsonl
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
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface SilverInfo {
  label: string;
  veto_reason?: string | null;
  vote_has_leakage?: boolean;
  output?: { next_topic_leakage?: boolean; hard_negative?: boolean } | null;
}

async function evaluateEpisode(
  entry: { id: string; title: string },
  silver: Map<string, SilverInfo>,
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
  const accepted: { fp: string; score: number; silver: SilverInfo | null; dimensions: Record<string, number> }[] = [];
  for (const seg of kept) {
    const judgement = judgeSegmentHeuristically(seg);
    const score = computeClipScore(judgement.dimensions, seg);
    const fp = fpOf(seg, transcript.videoId);
    if (score.finalScore >= config.pipeline.clipScoreThreshold) {
      accepted.push({ fp, score: round(score.finalScore, 3), silver: silver.get(`c=${fp}`) ?? null, dimensions: judgement.dimensions });
    }
  }
  accepted.sort((a, b) => b.score - a.score);

  const hardNegativeAccepted = accepted.filter((a) => a.silver?.label === 'FAIL').length;
  const leakageAccepted = accepted.filter((a) => a.silver?.vote_has_leakage === true).length;

  return {
    episode_id: transcript.videoId,
    episode_title: entry.title,
    raw_candidates: detection.candidateCount,
    eligible_candidates: kept.length,
    accepted: accepted.map((a) => ({ candidate_id: `c=${a.fp}`, score: a.score, silver: a.silver?.label ?? null })),
    top_1: accepted[0] ? { candidate_id: `c=${accepted[0].fp}`, score: accepted[0].score, silver: accepted[0].silver?.label ?? null } : null,
    top_2: accepted[1] ? { candidate_id: `c=${accepted[1].fp}`, score: accepted[1].score, silver: accepted[1].silver?.label ?? null } : null,
    top_3: accepted[2] ? { candidate_id: `c=${accepted[2].fp}`, score: accepted[2].score, silver: accepted[2].silver?.label ?? null } : null,
    accepted_silver_pass_count: accepted.filter((a) => a.silver?.label === 'PASS').length,
    accepted_silver_fail_count: accepted.filter((a) => a.silver?.label === 'FAIL').length,
    hard_negative_accepted: hardNegativeAccepted,
    next_topic_leakage_accepted: leakageAccepted,
    first_death_summary: twoPass.warnings.slice(0, 10),
    fallback_provider_failures: {
      provider_failure: false,
      fallback_used: config.ai.defaultProvider === null,
    },
    negative_duration_count: kept.filter((s) => s.durationSec < 0).length,
  };
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

async function main(): Promise<void> {
  const labelsPath = arg('labels') ?? 'evidence/v13/consensus_labels_v13.jsonl';
  const outPath = arg('out') ?? 'evidence/v13/production_g2.jsonl';

  const silver = new Map<string, SilverInfo>();
  if (fs.existsSync(path.resolve(labelsPath))) {
    for (const line of fs.readFileSync(path.resolve(labelsPath), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as { candidate_id: string; label: string; veto_reason?: string | null; votes?: { tier: string; critical_veto: boolean | null }[] };
      if (rec.candidate_id) {
        const hasLeakage = (rec.votes ?? []).some((v) => v.critical_veto === true);
        silver.set(rec.candidate_id, { label: rec.label, veto_reason: rec.veto_reason, vote_has_leakage: hasLeakage, output: null });
      }
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
  const episodesWithPass = rows.filter((r) => Number(r.accepted_silver_pass_count ?? 0) > 0).length;
  const top1PassEpisodes = rows.filter((r) => (r.top_1 as { silver?: string } | null)?.silver === 'PASS').length;
  const top3PassEpisodes = rows.filter((r) => (r.top_3 as { silver?: string } | null)?.silver === 'PASS' || (r.top_2 as { silver?: string } | null)?.silver === 'PASS' || (r.top_1 as { silver?: string } | null)?.silver === 'PASS').length;

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), rows.map((o) => JSON.stringify(o)).join('\n'), 'utf-8');

  const summary = {
    episodes_evaluated: rows.length,
    episodes_ok: episodesOk,
    negative_duration_total: negativeDurationTotal,
    episodes_with_silver_pass_accepted: episodesWithPass,
    top1_silver_pass_episodes: top1PassEpisodes,
    top3_silver_pass_episodes: top3PassEpisodes,
  };
  fs.writeFileSync(path.resolve(outPath.replace(/\.jsonl$/, '_summary.json')), JSON.stringify(summary, null, 2), 'utf-8');
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});