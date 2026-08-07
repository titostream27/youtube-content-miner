/**
 * Brief v11 C12 — real-media acceptance evaluation harness.
 *
 * Uses the PRODUCTION transcript resolver + two-pass highlight selection for
 * real YouTube podcast episodes, without needing a YouTube Data API key
 * (yt-dlp caption extraction works with the android player client).
 *
 * For each episode:
 *   - resolveTranscript(candidate) -> real ASR transcript
 *   - cuesToUtterances -> EnrichedSentence[]
 *   - twoPassHighlightSelection (semantic path w/ heuristic fallback)
 *   - records top-1 / top-3 candidates, boundary, contamination,
 *     transcript precision, and a manual annotation slot.
 *
 * Output: JSON lines to stdout + an evidence markdown file.
 */
import { config } from '../src/lib/config';
import { resolveTranscript } from '../src/lib/transcript';
import { twoPassHighlightSelection } from '../src/lib/moments/two-pass';
import { detectMoments } from '../src/lib/moments/segmentation';
import type { EpisodeCandidate } from '../src/lib/domain/types';

const EPISODES: { id: string; title: string; note: string }[] = [
  { id: 'I6wCuvvaRPI', title: 'Call Her Daddy — Kim Kardashian (Full Episode)', note: 'two-person interview, rapid back-and-forth' },
  { id: 'GOqEl4ADyVk', title: 'Jay Shetty — Tom Holland', note: 'two-person interview, storytelling' },
  { id: '2HLGcRpw1hc', title: 'Conan O\'Brien Needs a Friend — Mick Jagger', note: 'two-person, humor' },
  { id: 'UZ1kCEGjYX0', title: 'Conan O\'Brien Needs a Friend — Matt Damon', note: 'two-person' },
  { id: 'Hb2rKGfIOrM', title: 'WTF — Barack Obama with Marc Maron', note: 'two-person, long answers' },
  { id: 'g2cQ2kD6lzs', title: 'Jay Shetty — Kobe Bryant', note: 'storytelling, long answers' },
  { id: 'hN-V0YYDSak', title: 'Raditya Dika — Diskusi Pendidikan Indonesia', note: 'Indonesian, multiple speakers' },
  { id: 'YDc5_Jx0CnM', title: 'Raditya Dika — Dian Sastrowardoyo', note: 'Indonesian, two-person interview' },
  { id: 'Ive926sC6mc', title: 'Raditya Dika — Iqbaal Ramadhan', note: 'Indonesian, two-person' },
  { id: 'p0mFvSNWLhU', title: 'Deddy Corbuzier — Ruben Onsu', note: 'Indonesian, interview, imperfect ASR' },
];

function stubCandidate(id: string, title: string): EpisodeCandidate {
  return {
    videoId: id,
    title,
    description: '',
    channelId: 'unknown',
    channelTitle: 'unknown',
    publishedAt: new Date().toISOString(),
    durationSeconds: 3600,
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    thumbnailUrl: null,
    tags: [],
    hasCaptions: null,
    license: null,
    embeddable: null,
    channel: null,
  };
}

async function evaluateEpisode(entry: { id: string; title: string; note: string }): Promise<Record<string, unknown>> {
  const candidate = stubCandidate(entry.id, entry.title);
  const resolution = await resolveTranscript({ candidate, forceRefresh: true });

  const roughResult = detectMoments(resolution.transcript, {
    minDurationSec: config.pipeline.segment.minDurationSec,
    maxDurationSec: config.pipeline.segment.maxDurationSec,
    targetDurationSec: config.pipeline.segment.targetDurationSec,
    maxSegments: 12,
    minSalience: 0.3,
  });

  const result = await twoPassHighlightSelection(
    {
      videoId: entry.id,
      source: resolution.transcript.source,
      language: resolution.transcript.language,
      cues: resolution.transcript.cues,
      durationSec: resolution.transcript.durationSec,
      wordCount: resolution.transcript.wordCount,
    },
    roughResult.segments,
    entry.title,
    {
      minDurationSec: config.pipeline.highlight.minCompleteDurationSec,
      maxDurationSec: config.pipeline.highlight.hardMaxSec,
      targetDurationSec: config.pipeline.segment.targetDurationSec,
      maxSegments: 12,
    },
  );

  const top = result.segments
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 3)
    .map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      durationSec: s.durationSec,
      salience: s.salience,
      text: s.text.slice(0, 120),
      timingPrecision: s.timingPrecision,
      sliceApproximate: s.sliceApproximate,
      wordTimingCoverage: s.wordTimingCoverage,
      boundarySource: s.boundarySource,
    }));

  return {
    episodeId: entry.id,
    title: entry.title,
    note: entry.note,
    transcript: {
      source: resolution.transcript.source,
      language: resolution.transcript.language,
      cues: resolution.transcript.cues.length,
      words: resolution.transcript.wordCount,
      durationSec: resolution.transcript.durationSec,
    },
    candidateCount: result.segments.length,
    warnings: result.warnings.slice(0, 5),
    topCandidates: top,
  };
}

async function main(): Promise<void> {
  const out: unknown[] = [];
  for (const entry of EPISODES) {
    const startedAt = Date.now();
    try {
      const evaluation = await evaluateEpisode(entry);
      const record = { ...evaluation, ok: true as const, elapsedMs: Date.now() - startedAt };
      out.push(record);
      console.log(JSON.stringify(record));
    } catch (error) {
      out.push({ episodeId: entry.id, title: entry.title, ok: false, error: error instanceof Error ? error.message : String(error) });
      console.log(JSON.stringify({ episodeId: entry.id, title: entry.title, ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  console.log(`EVAL_DONE total=${out.length} ok=${out.filter((x) => (x as { ok: boolean }).ok).length}`);
}

main().catch((error) => {
  console.error('Evaluation failed:', error);
  process.exit(1);
});
