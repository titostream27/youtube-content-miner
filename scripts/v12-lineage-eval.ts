/**
 * Brief V12 Phase B — Candidate lineage instrumentation.
 *
 * Diagnostic driver: runs the SAME production functions used by analyzeEpisode
 * (detectMoments -> twoPassHighlightSelection) over the frozen 10-episode
 * corpus and emits one machine-readable lineage row per rough candidate
 * (including rejected ones), plus one episode summary row and an EVAL_DONE row.
 *
 * Changes NO production semantics; only reads the pipeline and writes JSONL.
 * Does NOT lower thresholds, does NOT inject timestamps, does NOT claim human
 * review.
 *
 * Env: DATABASE_PATH (production DB), --env-file content-miner/.env
 * Usage:
 *   DATABASE_PATH=... node --env-file=.../.env --import tsx scripts/v12-lineage-eval.ts
 */
import { config } from '../src/lib/config';
import type { MomentSegment, Transcript } from '../src/lib/domain/types';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { detectMoments } from '../src/lib/moments/segmentation';
import { cuesToUtterances, type Utterance } from '../src/lib/moments/utterances';
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

const CFG = {
  minDur: config.pipeline.segment.minDurationSec,
  maxDur: config.pipeline.segment.maxDurationSec,
  targetDur: config.pipeline.segment.targetDurationSec,
  maxSegments: config.pipeline.maxScoredSegmentsPerEpisode,
  clipThreshold: config.pipeline.clipScoreThreshold,
  minEndingConfidence: config.pipeline.highlight.minEndingConfidence,
  minComplete: config.pipeline.highlight.minCompleteDurationSec,
  lookahead: config.pipeline.highlight.nextTopicLookaheadSec,
  endGuard: config.pipeline.highlight.endGuardSec,
  maxContamination: config.pipeline.highlight.maxNextTopicContamination,
};

const REJECT_STAGES: { re: RegExp; stage: string }[] = [
  { re: /invalid semantic range|invalid guarded range/, stage: 'BOUNDARY_VALIDATION' },
  { re: /exceeds hard max/, stage: 'DURATION_POLICY' },
  { re: /too short/, stage: 'MIN_DURATION' },
  { re: /ending confidence/, stage: 'ENDING_CONFIDENCE' },
  { re: /ending incomplete/, stage: 'ENDING_COMPLETE' },
  { re: /contamination/, stage: 'NEXT_TOPIC_CONTAMINATION' },
  { re: /start gate|empty slice|finalize rejected/, stage: 'FINALIZE_START_GATE' },
  { re: /repaired but still invalid/, stage: 'REPAIR_REVALIDATION' },
];

function rejectionStage(warning: string): string {
  for (const r of REJECT_STAGES) {
    if (r.re.test(warning)) return r.stage;
  }
  return 'OTHER';
}

function warningForIndex(warnings: string[], index: number): string | undefined {
  return warnings.find((w) => w.includes(`highlight ${index}`) || w.includes(`idx=${index}`));
}

function excerptFor(
  utterances: Utterance[],
  startSec: number,
  endSec: number,
): { preceding: string; following: string; firstUtterance: string; lastUtterance: string } {
  const before = utterances
    .filter((u) => u.endSec <= startSec + 0.05)
    .slice(-3)
    .map((u) => u.text.trim())
    .join(' ');
  const after = utterances
    .filter((u) => u.startSec >= endSec - 0.05)
    .slice(0, 3)
    .map((u) => u.text.trim())
    .join(' ');
  const inside = utterances.filter((u) => u.endSec > startSec && u.startSec < endSec);
  return {
    preceding: before,
    following: after,
    firstUtterance: inside[0]?.text.trim() ?? '',
    lastUtterance: inside[inside.length - 1]?.text.trim() ?? '',
  };
}

function fpOf(segment: MomentSegment, videoId: string): string {
  return candidateFingerprint(
    videoId,
    segment.startSec,
    segment.endSec,
    segment.text.split(/\s+/).slice(0, 4).join(' '),
    segment.text.split(/\s+/).slice(-4).join(' '),
  );
}

async function evaluateEpisode(entry: { id: string; title: string }): Promise<Record<string, unknown> | null> {
  const transcript: Transcript | null = getTranscript(entry.id);
  if (!transcript || transcript.cues.length === 0) {
    return { episode_id: entry.id, ok: false, error: 'no cached transcript' };
  }
  const utterances = cuesToUtterances(transcript.cues);

  const detection = detectMoments(transcript, {
    minDurationSec: CFG.minDur,
    maxDurationSec: CFG.maxDur,
    targetDurationSec: CFG.targetDur,
    maxSegments: CFG.maxSegments,
  });
  const rough = detection.segments;

  const twoPass = await twoPassHighlightSelection(transcript, rough, entry.title, {
    minDurationSec: CFG.minDur,
    maxDurationSec: CFG.maxDur,
    targetDurationSec: CFG.targetDur,
    maxSegments: CFG.maxSegments,
  });
  const keptById = new Map<number, MomentSegment>();
  for (const segment of twoPass.segments) keptById.set(segment.index, segment);

  const ranked: { idx: number; fp: string; score: number; accepted: boolean }[] = [];
  const outputs: Record<string, unknown>[] = [];

  for (const seg of rough) {
    const idx = seg.index;
    const final = keptById.get(idx) ?? null;
    const warning = warningForIndex(twoPass.warnings, idx);
    const ending = twoPass.endingById.get(idx) ?? null;
    const start = final ? final.startSec : seg.startSec;
    const end = final ? final.endSec : seg.endSec;
    const excerpts = excerptFor(utterances, start, end);

    let componentScores: Record<string, number> | null = null;
    let finalScore: number | null = null;
    let caps: string[] = [];
    let accepted = false;
    if (final) {
      const judgement = judgeSegmentHeuristically(final);
      const score = computeClipScore(judgement.dimensions, final);
      componentScores = judgement.dimensions;
      finalScore = round(score.finalScore, 3);
      caps = score.appliedCaps.map((c) => c.reason);
      accepted = score.finalScore >= CFG.clipThreshold;
      ranked.push({ idx, fp: fpOf(seg, transcript.videoId), score: score.finalScore, accepted });
    }

    const record: Record<string, unknown> = {
      candidate_id: `c=${fpOf(seg, transcript.videoId).slice(0, 12)}`,
      episode_id: transcript.videoId,
      proposal_source: 'salience-window',
      rough_start_sec: round(seg.startSec, 2),
      rough_end_sec: round(seg.endSec, 2),
      rough_duration_sec: round(seg.durationSec, 2),
      final_start_sec: final ? round(final.startSec, 2) : null,
      final_end_sec: final ? round(final.endSec, 2) : null,
      final_duration_sec: final ? round(final.durationSec, 2) : null,
      kept: Boolean(final),
      rejection_stage: final
        ? (finalScore !== null && finalScore >= CFG.clipThreshold ? null : 'SCORING')
        : (warning ? rejectionStage(warning) : 'OTHER'),
      rejection_reason: final ? null : (warning ?? null),
      boundary_reason_start: ending ? (ending.startComplete === false ? 'START_INCOMPLETE' : 'START_OK') : null,
      boundary_reason_end: ending?.endingType ?? null,
      ending_type: ending?.endingType ?? null,
      ending_confidence: ending?.endingConfidence ?? null,
      contamination: ending?.nextTopicContamination ?? null,
      next_topic_detected: ending?.nextTopicRemoved ?? null,
      start_complete: ending?.startComplete ?? null,
      boundary_status: ending?.boundaryStatus ?? null,
      repair_reason: ending?.repairReason ?? null,
      first_utterance_text: excerpts.firstUtterance,
      last_utterance_text: excerpts.lastUtterance,
      preceding_context_excerpt: excerpts.preceding,
      following_context_excerpt: excerpts.following,
      topic_before: null,
      topic_inside: null,
      topic_after: null,
      component_scores: componentScores,
      final_score: finalScore,
      rank: null,
      accepted,
      caps,
      proposal_text_excerpt: seg.text.slice(0, 200),
    };
    outputs.push(record);
    stdout(record);
  }

  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach((entryRank, i) => {
    const target = outputs.find((o) => o.candidate_id === `c=${entryRank.fp.slice(0, 12)}`);
    if (target) target.rank = i + 1;
  });

  const summary: Record<string, unknown> = {
    episode_id: transcript.videoId,
    episode_title: entry.title,
    rough_count: rough.length,
    kept_count: keptById.size,
    accepted_count: ranked.filter((r) => r.accepted).length,
    rejection_funnel: countByStage(outputs),
    top_scores: ranked.slice(0, 5).map((r) => ({ idx: r.idx, score: round(r.score, 1), accepted: r.accepted })),
    config_snapshot: CFG,
  };
  stdout(summary);
  return summary;
}

function countByStage(outputs: Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of outputs) {
    const key = o.kept ? 'KEPT' : (o.rejection_stage as string) ?? 'OTHER';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function stdout(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main(): Promise<void> {
  // Keep stdout strict JSONL. Production pipeline diagnostics belong on stderr.
  console.log = (...values: unknown[]): void => {
    process.stderr.write(`${values.map(String).join(' ')}\n`);
  };
  console.warn = (...values: unknown[]): void => {
    process.stderr.write(`${values.map(String).join(' ')}\n`);
  };
  const results: Record<string, unknown>[] = [];
  for (const entry of CORPUS) {
    try {
      const res = await evaluateEpisode(entry);
      if (res) results.push(res);
    } catch (error) {
      const failed = { episode_id: entry.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      results.push(failed);
      stdout(failed);
    }
  }
  stdout({
    type: 'EVAL_DONE',
    total: CORPUS.length,
    evaluated: results.filter((r) => r.ok !== false).length,
  });
}

void main();