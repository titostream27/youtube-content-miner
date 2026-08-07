/**
 * Brief v11 C12 — production-path real-media evaluation (analyzeEpisode).
 *
 * Runs the REAL production analysis pipeline (transcript -> moments -> two-pass
 * -> LLM/heuristic scoring) for real YouTube episodes whose transcripts are
 * already cached by resolveTranscript. No timestamps are injected: boundaries
 * come entirely from the pipeline.
 *
 * Output: JSON lines + evidence file.
 */
import { config } from '../src/lib/config';
import { analyzeEpisode } from '../src/lib/pipeline/analyze-episode';
import { getTranscript } from '../src/lib/db/repositories/transcripts';
import type { EpisodeCandidate } from '../src/lib/domain/types';

const EPISODES: { id: string; title: string; note: string }[] = [
  { id: 'I6wCuvvaRPI', title: 'Call Her Daddy — Kim Kardashian (Full Episode)', note: 'two-person interview, rapid back-and-forth' },
  { id: 'GOqEl4ADyVk', title: 'Jay Shetty — Tom Holland', note: 'two-person interview, storytelling' },
  { id: '2HLGcRpw1hc', title: 'Conan O\'Brien Needs a Friend — Mick Jagger', note: 'two-person, humor' },
  { id: 'UZ1kCEGjYX0', title: 'Conan O\'Brien Needs a Friend — Matt Damon', note: 'two-person' },
  { id: 'Hb2rKGfIOrM', title: 'WTF — Barack Obama with Marc Maron', note: 'two-person, long answers' },
  { id: 'g2cQ2kD6lzs', title: 'Jay Shetty — Kobe Bryant', note: 'storytelling, long answers' },
  { id: 'Ive926sC6mc', title: 'Raditya Dika — Iqbaal Ramadhan', note: 'Indonesian, two-person' },
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

async function main(): Promise<void> {
  const out: unknown[] = [];
  for (const entry of EPISODES) {
    const startedAt = Date.now();
    const cached = getTranscript(entry.id);
    if (!cached || cached.cues.length === 0) {
      out.push({ episodeId: entry.id, ok: false, error: 'no cached transcript (skipped)' });
      console.log(JSON.stringify({ episodeId: entry.id, ok: false, error: 'no cached transcript (skipped)' }));
      continue;
    }
    try {
      const analysis = await analyzeEpisode({
        candidate: stubCandidate(entry.id, entry.title),
        topic: 'podcast highlight',
        clipScoreThreshold: config.pipeline.clipScoreThreshold,
      });
      out.push({
        episodeId: entry.id,
        title: entry.title,
        note: entry.note,
        ok: true,
        elapsedMs: Date.now() - startedAt,
        transcript: {
          source: analysis.transcript.source,
          cues: analysis.transcript.cues.length,
          words: analysis.transcript.wordCount,
          durationSec: analysis.transcript.durationSec,
        },
        engine: analysis.engine,
        segmentCount: analysis.segments.length,
        clipCount: analysis.clips.length,
        warnings: analysis.warnings.slice(0, 5),
        topClips: analysis.clips.slice(0, 3).map((c) => ({
          startSec: c.startSec,
          endSec: c.endSec,
          durationSec: c.durationSec,
          finalScore: c.finalScore,
          confidence: c.confidence,
          tier: c.tier,
          title: c.title,
          suggestedHook: c.suggestedHook,
          suggestedCaption: c.suggestedCaption,
          boundarySource: c.boundarySource,
          timingPrecision: (c as { timingPrecision?: string }).timingPrecision,
        })),
        allClips: analysis.allClips.map((c) => ({
          startSec: c.startSec,
          endSec: c.endSec,
          durationSec: c.durationSec,
          finalScore: c.finalScore,
          tier: c.tier,
        })),
      });
      console.log(JSON.stringify(out[out.length - 1]));
    } catch (error) {
      out.push({ episodeId: entry.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      console.log(JSON.stringify({ episodeId: entry.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  console.log(`EVAL_DONE total=${out.length} ok=${out.filter((x) => (x as { ok: boolean }).ok).length}`);
}

main().catch((error) => {
  console.error('Evaluation failed:', error);
  process.exit(1);
});
