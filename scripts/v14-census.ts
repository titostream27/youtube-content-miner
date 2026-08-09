/**
 * Brief V14 Phase P2 — Candidate census for the four new frozen episodes.
 *
 * Uses EXACTLY the same candidate-generation path as the V13 baseline
 * (scripts/v12-lineage-eval.ts): detectMoments -> twoPassHighlightSelection
 * -> per-rough-candidate lineage row. Only the episode list and emitted
 * generator_version + transcript hash differ; production semantics unchanged.
 *
 * Usage:
 *   DATABASE_PATH=... node --env-file=... --import tsx scripts/v14-census.ts
 *     --out evidence/v14/census_new.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

/** The only non-legacy cached transcripts in the production DB (2026-08-09). */
const NEW_CORPUS: { id: string; title: string | null }[] = [
  { id: 'LAmGfokvgzA', title: null },
  { id: 'e1WM_JEmP-Q', title: null },
  { id: 'hb7Oqrj3F3k', title: null },
  { id: 'vs6x8VUGXCw', title: null },
];

const GENERATOR_VERSION = 'v14-lineage-v1';

const CFG = {
  minDur: config.pipeline.segment.minDurationSec,
  maxDur: config.pipeline.segment.maxDurationSec,
  targetDur: config.pipeline.segment.targetDurationSec,
  maxSegments: config.pipeline.maxScoredSegmentsPerEpisode,
  clipThreshold: config.pipeline.clipScoreThreshold,
  minEndingConfidence: config.pipeline.highlight.minEndingConfidence,
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
  for (const w of REJECT_STAGES) {
    if (w.re.test(warning)) return w.stage;
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

function transcriptHash(transcript: Transcript): string {
  return createHash('sha256').update(JSON.stringify(transcript.cues)).digest('hex');
}

async function evaluateEpisode(
  entry: { id: string; title: string | null },
): Promise<{ rows: Record<string, unknown>[]; summary: Record<string, unknown> }> {
  const transcript: Transcript | null = getTranscript(entry.id);
  if (!transcript || transcript.cues.length === 0) {
    return {
      rows: [],
      summary: { episode_id: entry.id, ok: false, error: 'no cached transcript' },
    };
  }
  const utterances = cuesToUtterances(transcript.cues);

  const detection = detectMoments(transcript, {
    minDurationSec: CFG.minDur,
    maxDurationSec: CFG.maxDur,
    targetDurationSec: CFG.targetDur,
    maxSegments: CFG.maxSegments,
  });
  const rough = detection.segments;

  const twoPass = await twoPassHighlightSelection(transcript, rough, entry.title ?? entry.id, {
    minDurationSec: CFG.minDur,
    maxDurationSec: CFG.maxDur,
    targetDurationSec: CFG.targetDur,
    maxSegments: CFG.maxSegments,
  });
  const keptById = new Map<number, MomentSegment>();
  for (const segment of twoPass.segments) keptById.set(segment.index, segment);

  const ranked: { idx: number; fp: string; score: number; accepted: boolean }[] = [];
  const rows: Record<string, unknown>[] = [];

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

    rows.push({
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
      component_scores: componentScores,
      final_score: finalScore,
      rank: null,
      accepted,
      caps,
      proposal_text_excerpt: seg.text.slice(0, 200),
      generator_version: GENERATOR_VERSION,
      transcript_hash: transcriptHash(transcript),
      acquired_at: new Date().toISOString(),
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  for (const [i, entryRank] of ranked.entries()) {
    const target = rows.find((o) => o.candidate_id === `c=${entryRank.fp.slice(0, 12)}`);
    if (target) target.rank = i + 1;
  }

  return {
    rows,
    summary: {
      episode_id: transcript.videoId,
      rough_count: rough.length,
      kept_count: keptById.size,
      accepted_count: ranked.filter((r) => r.accepted).length,
      transcript_hash: transcriptHash(transcript),
      config_snapshot: CFG,
      generator_version: GENERATOR_VERSION,
      ok: true,
    },
  };
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const outPath = path.resolve(arg('out') ?? 'evidence/v14/census_new.jsonl');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const summaries: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const entry of NEW_CORPUS) {
    try {
      const { rows, summary } = await evaluateEpisode(entry);
      for (const r of rows) lines.push(JSON.stringify(r));
      summaries.push(summary);
    } catch (error) {
      summaries.push({ episode_id: entry.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  lines.push(JSON.stringify({ type: 'CENSUS_DONE', total: NEW_CORPUS.length, summaries }));
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
  console.log(JSON.stringify(summaries, null, 2));
  console.log(`rows written: ${lines.length - 1} -> ${outPath}`);
}

void main();