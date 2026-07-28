import {
  estimateSttCostUsd,
  SpeechToTextUnavailableError,
  transcribeWithSpeechToText,
} from '../stt';
import {
  attemptFailed,
  attemptSucceeded,
  type TranscriptAttempt,
  type TranscriptFetchInput,
  type TranscriptProvider,
} from './types';

/**
 * Speech-to-text, last in the chain.
 *
 * Worth being precise about what this does and does not solve. It is *not* a
 * workaround for caption blocking: transcribing requires the audio, and
 * downloading audio faces the same anti-bot layer as captions while costing
 * roughly two orders of magnitude more (a two hour episode runs to dollars, not
 * fractions of a cent).
 *
 * Its real value is fidelity, not availability - specifically speaker
 * diarization, which YouTube's ASR does not provide at all. Knowing whether the
 * host or the guest delivered a line materially improves the `standalone`
 * judgement. If this is implemented, choose a provider that offers diarization
 * rather than a plain Whisper endpoint, or the extra spend buys nothing the
 * caption track was not already giving.
 */
export const sttProvider: TranscriptProvider = {
  id: 'stt',

  async fetch(input: TranscriptFetchInput): Promise<TranscriptAttempt> {
    try {
      const transcript = await transcribeWithSpeechToText({
        videoId: input.candidate.videoId,
        durationSeconds: input.candidate.durationSeconds,
      });
      return attemptSucceeded('stt', transcript);
    } catch (error) {
      const detail =
        error instanceof SpeechToTextUnavailableError ? error.detail : String(error);
      return attemptFailed(
        'stt',
        `${detail} (estimated cost would have been $${estimateSttCostUsd(
          input.candidate.durationSeconds,
        ).toFixed(2)})`,
      );
    }
  },
};
