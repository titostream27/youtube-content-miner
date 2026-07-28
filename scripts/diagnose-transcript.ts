/**
 * Diagnose transcript acquisition for one video.
 *
 * Answers the question an operator actually has when an episode will not
 * analyse: which providers ran, what each one said, and whether the failure was
 * "this video has no captions" or "we were blocked".
 *
 *   npx tsx scripts/diagnose-transcript.ts dQw4w9WgXcQ
 *   TRANSCRIPT_PROVIDERS=ytdlp npx tsx scripts/diagnose-transcript.ts <videoId>
 */
import { config } from '../src/lib/config';
import type { EpisodeCandidate } from '../src/lib/domain/types';
import { describeProviderChain, resolveTranscript, TranscriptUnavailableError } from '../src/lib/transcript';
import { cuesToSentences } from '../src/lib/moments/segmentation';

function stubCandidate(videoId: string): EpisodeCandidate {
  return {
    videoId,
    title: `(diagnostic) ${videoId}`,
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
    // Unknown rather than false, so the caption provider is not skipped.
    hasCaptions: null,
    license: null,
    embeddable: null,
    channel: null,
  };
}

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) {
    console.error('Usage: tsx scripts/diagnose-transcript.ts <videoId>');
    process.exit(1);
  }

  console.log(`Video: ${videoId}`);
  console.log(`Languages: ${config.youtube.transcriptLanguages.join(', ')}\n`);

  console.log('Provider chain');
  for (const entry of describeProviderChain()) {
    const state = entry.ready ? 'ready' : 'unavailable';
    console.log(
      `  ${String(entry.position ?? '-').padStart(2)}. ${entry.label.padEnd(34)} ${state}` +
        (entry.reason ? `  (${entry.reason})` : ''),
    );
  }
  console.log('');

  try {
    // forceRefresh so a cached row does not mask what the providers actually do.
    const result = await resolveTranscript({
      candidate: stubCandidate(videoId),
      forceRefresh: true,
    });

    console.log('RESULT: transcript obtained');
    console.log(`  provider   : ${result.origin}`);
    console.log(`  source     : ${result.transcript.source}`);
    console.log(`  language   : ${result.transcript.language}`);
    console.log(`  cues       : ${result.transcript.cues.length}`);
    console.log(`  words      : ${result.transcript.wordCount}`);
    console.log(`  duration   : ${Math.round(result.transcript.durationSec)}s`);

    const sentences = cuesToSentences(result.transcript.cues);
    console.log(`  sentences  : ${sentences.length}`);

    const punctuated = result.transcript.cues.filter((cue) => /[.,?!]/.test(cue.text)).length;
    console.log(
      `  punctuation: ${punctuated}/${result.transcript.cues.length} cues ` +
        `(matters - segmentation cuts on sentence boundaries)`,
    );

    const preview = result.transcript.cues
      .slice(0, 8)
      .map((cue) => cue.text)
      .join(' ');
    console.log(`\n  preview: ${preview.slice(0, 220)}`);

    if (result.attempts.length > 0) {
      console.log('\n  attempts before success:');
      for (const attempt of result.attempts) console.log(`    - ${attempt}`);
    }
    if (result.warnings.length > 0) {
      console.log('\n  warnings:');
      for (const warning of result.warnings) console.log(`    - ${warning}`);
    }
  } catch (error) {
    if (error instanceof TranscriptUnavailableError) {
      console.log(`RESULT: no transcript (blocked=${error.blocked})`);
      for (const attempt of error.attempts) console.log(`  - ${attempt}`);
      console.log(
        error.blocked
          ? '\n  Diagnosis: anti-bot enforcement, not absence of captions. Configure a hosted\n' +
              '  transcript API (TRANSCRIPT_API_URL) or a residential proxy (YTDLP_PROXY).'
          : '\n  Diagnosis: the captions genuinely could not be located for these languages.',
      );
    } else {
      console.error('Unexpected failure:', error);
      process.exitCode = 1;
    }
  }
}

void main();
