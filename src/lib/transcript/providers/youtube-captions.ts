import { config } from '@/lib/config';
import { fetchYouTubeCaptions } from '@/lib/youtube/captions';
import {
  attemptFailed,
  attemptSucceeded,
  type TranscriptAttempt,
  type TranscriptFetchInput,
  type TranscriptProvider,
} from './types';

/**
 * Direct watch-page caption scrape.
 *
 * Free and dependency-free, and it works from residential connections and local
 * development. From a datacenter IP it is normally refused, so it belongs at the
 * end of the chain rather than the start - useful as a zero-config fallback, not
 * as the primary path for a hosted deployment.
 */
export const youtubeCaptionsProvider: TranscriptProvider = {
  id: 'captions',

  async fetch(input: TranscriptFetchInput): Promise<TranscriptAttempt> {
    // `hasCaptions === false` is a reliable negative from the Data API, so there
    // is no point scraping a watch page for a track that does not exist.
    if (input.candidate.hasCaptions === false) {
      return attemptFailed('captions', 'video reports no caption track');
    }

    // A hung watch-page fetch must not stall a whole run. The provider chain is
    // called with an optional external signal that may never fire, so combine it
    // with a hard ceiling here.
    const timeout = AbortSignal.timeout(config.transcript.captions.timeoutMs);
    const combined = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

    const result = await fetchYouTubeCaptions({
      videoId: input.candidate.videoId,
      preferredLanguages: input.preferredLanguages,
      signal: combined,
    });

    return result.transcript
      ? attemptSucceeded('captions', result.transcript)
      : attemptFailed('captions', result.reason ?? 'unavailable', result.blocked);
  },
};
