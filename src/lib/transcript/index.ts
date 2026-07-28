import { config } from '@/lib/config';
import type { EpisodeCandidate, Transcript } from '@/lib/domain/types';
import { getTranscript as readCachedTranscript, saveTranscript } from '@/lib/db/repositories/transcripts';
import { fetchYouTubeCaptions } from '@/lib/youtube/captions';
import { getFixtureTranscript } from '@/lib/youtube/fixtures';
import {
  SpeechToTextUnavailableError,
  transcribeWithSpeechToText,
} from './stt';

/**
 * PRD Step 3 - Transcript extraction.
 *
 * Resolution order, cheapest first:
 *   1. Local cache      - free, and the reason repeat runs cost almost nothing.
 *   2. Demo fixture     - when running without a YouTube key.
 *   3. Caption track    - free, and available for the large majority of podcasts.
 *   4. Speech-to-text   - paid fallback (see `stt.ts` for its current limits).
 */

export type TranscriptOrigin = 'cache' | 'fixture' | 'captions' | 'stt';

export interface TranscriptResolution {
  transcript: Transcript;
  origin: TranscriptOrigin;
  warnings: string[];
}

export class TranscriptUnavailableError extends Error {
  readonly attempts: string[];

  constructor(videoId: string, attempts: string[]) {
    super(`No transcript could be obtained for ${videoId}`);
    this.name = 'TranscriptUnavailableError';
    this.attempts = attempts;
  }
}

export async function resolveTranscript(params: {
  candidate: EpisodeCandidate;
  /** Skip the cache, e.g. when re-running after a caption fix. */
  forceRefresh?: boolean;
  signal?: AbortSignal;
}): Promise<TranscriptResolution> {
  const { candidate, forceRefresh = false, signal } = params;
  const attempts: string[] = [];
  const warnings: string[] = [];

  if (!forceRefresh) {
    const cached = readCachedTranscript(candidate.videoId);
    if (cached && cached.cues.length > 0) {
      return { transcript: cached, origin: 'cache', warnings };
    }
    attempts.push('cache: miss');
  }

  if (config.youtube.demoMode) {
    const fixture = getFixtureTranscript(candidate.videoId);
    if (fixture) {
      saveTranscript(fixture);
      return { transcript: fixture, origin: 'fixture', warnings };
    }
    attempts.push('fixture: no demo transcript for this video id');
  }

  // `hasCaptions === false` is a reliable negative from the Data API, so we can
  // skip straight to STT instead of scraping a watch page for nothing.
  if (candidate.hasCaptions !== false) {
    const result = await fetchYouTubeCaptions({
      videoId: candidate.videoId,
      preferredLanguages: config.youtube.transcriptLanguages,
      signal,
    });

    if (result.transcript) {
      saveTranscript(result.transcript);
      if (result.transcript.source === 'youtube_asr') {
        warnings.push(
          `${candidate.videoId}: using auto-generated captions, confidence is capped accordingly.`,
        );
      }
      return { transcript: result.transcript, origin: 'captions', warnings };
    }

    attempts.push(`captions: ${result.reason ?? 'unavailable'}`);
  } else {
    attempts.push('captions: video reports no caption track');
  }

  try {
    const transcript = await transcribeWithSpeechToText({
      videoId: candidate.videoId,
      durationSeconds: candidate.durationSeconds,
    });
    saveTranscript(transcript);
    return { transcript, origin: 'stt', warnings };
  } catch (error) {
    attempts.push(
      `stt: ${error instanceof SpeechToTextUnavailableError ? error.detail : String(error)}`,
    );
  }

  throw new TranscriptUnavailableError(candidate.videoId, attempts);
}

export { SpeechToTextUnavailableError, estimateSttCostUsd, isSttConfigured } from './stt';
