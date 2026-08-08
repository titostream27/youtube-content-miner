/**
 * Brief V11 boundary-recovery real-media evaluation.
 *
 * Runs the real production chain for the canonical 10-episode G1 corpus:
 * cached real transcript -> rough detection -> two-pass boundary repair ->
 * final validation -> scoring -> ranking. No timestamps are injected.
 *
 * Stdout contains one JSON object per episode followed by an EVAL_DONE summary.
 * A non-zero negative temporal range sets process.exitCode = 1.
 */
import { config } from '../src/lib/config';
import type { EpisodeCandidate, ScoredClip, Transcript } from '../src/lib/domain/types';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import { detectMoments } from '../src/lib/moments/segmentation';
import { analyzeEpisode } from '../src/lib/pipeline/analyze-episode';

const CORPUS: { id: string; title: string; format: string }[] = [
  { id: 'I6wCuvvaRPI', title: 'KIM KARDASHIAN (Full Episode)', format: 'rapid two-person interview' },
  { id: 'GOqEl4ADyVk', title: 'TOM HOLLAND: How Tom Overcame Social Anxiety- The Mindset That Changed Everything!', format: 'long-answer interview' },
  { id: '2HLGcRpw1hc', title: "Mick Jagger (Full Episode) | Conan O'Brien Needs A Friend", format: 'fast two-person conversation' },
  { id: 'UZ1kCEGjYX0', title: "Matt Damon (FULL EPISODE) | Conan O'Brien Needs A Friend", format: 'fast two-person conversation' },
  { id: 'Hb2rKGfIOrM', title: 'President Barack Obama in Conversation with Marc Maron | WTF Podcast', format: 'long-answer interview' },
  { id: 'g2cQ2kD6lzs', title: "KOBE BRYANT'S LAST GREAT INTERVIEW On How To FIND PURPOSE In LIFE | Kobe Bryant & Jay Shetty", format: 'long-answer interview' },
  { id: 'Ive926sC6mc', title: 'Sisi Lain Iqbaal Ramadhan', format: 'Indonesian two-person interview' },
  { id: '3NSC5nps3OM', title: 'Cerita Cinta Idgitaf', format: 'Indonesian two-person interview' },
  { id: '376JmatmnaI', title: 'Millie Bobby Brown: Not Eleven Forever (Full Episode)', format: 'rapid two-person interview' },
  { id: 'XuoqKYxDHVc', title: 'The full-length interview with Elon Musk | The Economist', format: 'two-person interview' },
];

function candidateFor(transcript: Transcript, title: string): EpisodeCandidate {
  return {
    videoId: transcript.videoId,
    title,
    description: '',
    channelId: 'evidence-cache',
    channelTitle: 'see G1 manifest',
    publishedAt: '1970-01-01T00:00:00.000Z',
    durationSeconds: transcript.durationSec,
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    thumbnailUrl: null,
    tags: [],
    hasCaptions: true,
    license: null,
    embeddable: null,
    channel: null,
  };
}

function transcriptTiming(transcript: Transcript): {
  timingPrecision: 'word' | 'hybrid' | 'cue';
  timingCoverage: number;
} {
  const timedWords = transcript.cues.reduce((sum, cue) => sum + (cue.words?.length ?? 0), 0);
  const timedCues = transcript.cues.filter((cue) => (cue.words?.length ?? 0) > 0).length;
  const timingPrecision = timedCues === 0
    ? 'cue'
    : timedCues === transcript.cues.length
      ? 'word'
      : 'hybrid';
  const timingCoverage = transcript.wordCount > 0
    ? Math.min(1, Number((timedWords / transcript.wordCount).toFixed(4)))
    : 0;
  return { timingPrecision, timingCoverage };
}

function topResult(clip: ScoredClip): Record<string, unknown> {
  return {
    start_sec: clip.startSec,
    end_sec: clip.endSec,
    duration_sec: clip.durationSec,
    score: clip.finalScore,
    confidence: clip.confidence,
    boundary_source: clip.boundarySource ?? null,
    boundary_status: clip.boundaryStatus ?? null,
    ending_status: clip.endingType ?? null,
    ending_complete: clip.endingType
      ? !['QUESTION_START', 'TOPIC_TRANSITION', 'INCOMPLETE_SENTENCE', 'FILLER', 'UNKNOWN'].includes(clip.endingType)
      : null,
    contamination: clip.nextTopicContamination ?? null,
    timing_precision: (clip as ScoredClip & { timingPrecision?: string }).timingPrecision ?? null,
    timing_coverage: (clip as ScoredClip & { timingCoverage?: number }).timingCoverage ?? null,
  };
}

function rejectionCategories(warnings: string[]): Record<string, number> {
  const categories: Record<string, number> = {};
  for (const warning of warnings) {
    let category = 'other';
    if (/too short/i.test(warning)) category = 'too_short';
    else if (/ending confidence/i.test(warning)) category = 'ending_confidence';
    else if (/ending incomplete/i.test(warning)) category = 'ending_incomplete';
    else if (/contamination/i.test(warning)) category = 'contamination';
    else if (/start gate|empty slice|finalize rejected/i.test(warning)) category = 'start_or_finalization';
    categories[category] = (categories[category] ?? 0) + 1;
  }
  return categories;
}

function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  // Keep stdout strict JSONL. Production pipeline diagnostics belong on
  // stderr and remain available as the companion log artifact.
  console.log = (...values: unknown[]): void => {
    process.stderr.write(`${values.map(String).join(' ')}\n`);
  };
  const requestedIds = new Set(
    (process.env.EVAL_VIDEO_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const selectedCorpus = requestedIds.size > 0
    ? CORPUS.filter((entry) => requestedIds.has(entry.id))
    : CORPUS;
  const outputs: Record<string, unknown>[] = [];
  let negativeDurationCount = 0;

  for (const entry of selectedCorpus) {
    const index = CORPUS.findIndex((candidate) => candidate.id === entry.id);
    const transcript = getTranscript(entry.id);
    if (!transcript || transcript.cues.length === 0) {
      const unavailable = {
        episode_index: index + 1,
        episode: entry.title,
        video_id: entry.id,
        ok: false,
        acquisition_status: 'unusable',
        error: 'no cached transcript',
      };
      outputs.push(unavailable);
      emitJson(unavailable);
      continue;
    }

    const rough = detectMoments(transcript, {
      minDurationSec: config.pipeline.segment.minDurationSec,
      maxDurationSec: config.pipeline.segment.maxDurationSec,
      targetDurationSec: config.pipeline.segment.targetDurationSec,
      maxSegments: config.pipeline.maxScoredSegmentsPerEpisode,
    });

    try {
      const startedAt = Date.now();
      const analysis = await analyzeEpisode({
        candidate: candidateFor(transcript, entry.title),
        topic: 'podcast highlight',
        clipScoreThreshold: config.pipeline.clipScoreThreshold,
      });
      const allTemporal = [...rough.segments, ...analysis.segments, ...analysis.allClips];
      const episodeNegativeCount = allTemporal.filter(
        (item) =>
          !Number.isFinite(item.startSec) ||
          !Number.isFinite(item.endSec) ||
          !Number.isFinite(item.durationSec) ||
          item.endSec <= item.startSec ||
          item.durationSec <= 0,
      ).length + analysis.warnings.filter((warning) => /too short \(-/i.test(warning)).length;
      negativeDurationCount += episodeNegativeCount;

      const repairedCount = analysis.warnings.filter((warning) => /repaired/i.test(warning)).length;
      const fallbackUsed = analysis.warnings.some((warning) => /fallback|provider unavailable/i.test(warning));
      const timing = transcriptTiming(transcript);
      const output = {
        episode_index: index + 1,
        episode: entry.title,
        video_id: entry.id,
        format: entry.format,
        ok: true,
        acquisition_status: 'usable',
        transcript_source: transcript.source,
        language: transcript.language,
        duration_sec: transcript.durationSec,
        utterance_count: transcript.cues.length,
        timing_precision: timing.timingPrecision,
        timing_coverage: timing.timingCoverage,
        engine: analysis.engine,
        fallback_used: fallbackUsed,
        heuristic_only: analysis.engine === 'heuristic' && !fallbackUsed,
        threshold: config.pipeline.clipScoreThreshold,
        elapsed_ms: Date.now() - startedAt,
        rough_candidate_count: rough.segments.length,
        post_boundary_count: analysis.segments.length,
        repaired_count: repairedCount,
        accepted_count: analysis.clips.length,
        rejected_count: Math.max(0, rough.segments.length - analysis.segments.length),
        negative_duration_count: episodeNegativeCount,
        top1: analysis.clips[0] ? topResult(analysis.clips[0]) : null,
        top2: analysis.clips[1] ? topResult(analysis.clips[1]) : null,
        top3: analysis.clips[2] ? topResult(analysis.clips[2]) : null,
        rejection_reasons: rejectionCategories(analysis.warnings),
      };
      outputs.push(output);
      emitJson(output);
    } catch (error) {
      const failed = {
        episode_index: index + 1,
        episode: entry.title,
        video_id: entry.id,
        ok: false,
        acquisition_status: 'usable',
        error: error instanceof Error ? error.message : String(error),
      };
      outputs.push(failed);
      emitJson(failed);
    }
  }

  const usableCount = outputs.filter((output) => output.acquisition_status === 'usable').length;
  const evaluatedCount = outputs.filter((output) => output.ok === true).length;
  const acceptedTotal = outputs.reduce(
    (sum, output) => sum + (typeof output.accepted_count === 'number' ? output.accepted_count : 0),
    0,
  );
  emitJson({
    type: 'EVAL_DONE',
    total: selectedCorpus.length,
    usable_unique_episode_count: usableCount,
    evaluated_count: evaluatedCount,
    accepted_total: acceptedTotal,
    negative_duration_count: negativeDurationCount,
  });
  if (negativeDurationCount > 0) process.exitCode = 1;
}

void main();
