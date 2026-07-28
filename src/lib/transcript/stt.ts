import { config } from '@/lib/config';
import type { Transcript } from '@/lib/domain/types';

/**
 * PRD Step 3 fallback - speech-to-text.
 *
 * Scope note, stated plainly rather than faked:
 *
 * Transcribing an episode that has no caption track requires acquiring the
 * audio first. Doing that reliably means a media pipeline (yt-dlp or an
 * equivalent extractor, plus ffmpeg to segment long audio under provider upload
 * limits) running in a worker outside the request/response cycle. That is
 * infrastructure, not a scoring concern, and it is deliberately out of scope for
 * this milestone.
 *
 * What exists here is the seam: a single typed entry point the pipeline already
 * calls, which reports precisely why it cannot produce a transcript. When the
 * media worker lands, only this file changes.
 */

export class SpeechToTextUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Speech-to-text unavailable: ${detail}`);
    this.name = 'SpeechToTextUnavailableError';
    this.detail = detail;
  }
}

export interface SttRequest {
  videoId: string;
  /** Duration hint used to estimate cost before committing to a transcription. */
  durationSeconds: number;
}

/**
 * Rough cost estimate so the pipeline can warn before spending real money on a
 * three hour episode. Based on the common per-minute pricing tier for hosted
 * Whisper-class models.
 */
export function estimateSttCostUsd(durationSeconds: number): number {
  const minutes = durationSeconds / 60;
  const perMinuteUsd = 0.006;
  return Math.round(minutes * perMinuteUsd * 100) / 100;
}

export function isSttConfigured(): boolean {
  return Boolean(config.stt.provider && config.stt.apiKey);
}

export async function transcribeWithSpeechToText(request: SttRequest): Promise<Transcript> {
  if (!isSttConfigured()) {
    throw new SpeechToTextUnavailableError(
      'no STT provider configured (set STT_PROVIDER and STT_API_KEY)',
    );
  }

  throw new SpeechToTextUnavailableError(
    `audio extraction pipeline not implemented for ${request.videoId}; ` +
      `estimated cost would have been $${estimateSttCostUsd(request.durationSeconds).toFixed(2)}`,
  );
}
