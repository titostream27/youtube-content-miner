import { config } from '@/lib/config';
import type { EpisodeCandidate, Transcript } from '@/lib/domain/types';
import {
  getTranscript as readCachedTranscript,
  saveTranscript,
} from '@/lib/db/repositories/transcripts';
import { getFixtureTranscript } from '@/lib/youtube/fixtures';
import { loadProvider, resolveProviderChain, type TranscriptProviderId } from './providers';

/**
 * PRD Step 3 - Transcript extraction.
 *
 * Resolution order, cheapest first:
 *   1. Local cache   - free, and the reason repeat runs cost almost nothing.
 *   2. Demo fixture  - when running without a YouTube key.
 *   3. Provider chain - configurable; see `providers/index.ts`.
 *
 * Every provider that runs contributes a reason on failure, and the full attempt
 * log travels with the error. Diagnosing "why is this episode not analysed"
 * needs to distinguish "this video has no captions" from "we were blocked", and
 * a single generic failure message cannot do that.
 */

export type TranscriptOrigin = 'cache' | 'fixture' | TranscriptProviderId;

export interface TranscriptResolution {
  transcript: Transcript;
  origin: TranscriptOrigin;
  warnings: string[];
  /** Providers tried before the successful one, oldest first. */
  attempts: string[];
}

export class TranscriptUnavailableError extends Error {
  readonly attempts: string[];
  readonly blocked: boolean;

  constructor(videoId: string, attempts: string[], blocked: boolean) {
    super(
      blocked
        ? `Transcript for ${videoId} was blocked by YouTube on every configured provider`
        : `No transcript could be obtained for ${videoId}`,
    );
    this.name = 'TranscriptUnavailableError';
    this.attempts = attempts;
    this.blocked = blocked;
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
      return { transcript: cached, origin: 'cache', warnings, attempts };
    }
    attempts.push('cache: miss');
  }

  if (config.youtube.demoMode) {
    const fixture = getFixtureTranscript(candidate.videoId);
    if (fixture) {
      saveTranscript(fixture);
      return { transcript: fixture, origin: 'fixture', warnings, attempts };
    }
    attempts.push('fixture: no demo transcript for this video id');
  }

  const { active, skipped } = resolveProviderChain();

  for (const entry of skipped) {
    attempts.push(`${entry.descriptor.id}: skipped (${entry.reason})`);
  }

  if (active.length === 0) {
    warnings.push(
      'No transcript provider is configured. Set TRANSCRIPT_API_URL for a hosted vendor, ' +
        'or install yt-dlp.',
    );
    throw new TranscriptUnavailableError(candidate.videoId, attempts, false);
  }

  let sawBlock = false;

  for (const descriptor of active) {
    const provider = await loadProvider(descriptor);
    const attempt = await provider.fetch({
      candidate,
      preferredLanguages: config.youtube.transcriptLanguages,
      signal,
    });

    if (attempt.transcript) {
      saveTranscript(attempt.transcript);

      if (attempt.transcript.source === 'youtube_asr') {
        warnings.push(
          `${candidate.videoId}: auto-generated captions via ${provider.id}, confidence is capped accordingly.`,
        );
      }

      return {
        transcript: attempt.transcript,
        origin: provider.id,
        warnings,
        attempts,
      };
    }

    if (attempt.blocked) sawBlock = true;
    attempts.push(`${provider.id}: ${attempt.reason ?? 'unavailable'}`);
  }

  if (sawBlock) {
    warnings.push(
      `${candidate.videoId}: every provider was blocked. A hosted transcript API or a ` +
        'residential proxy is required for reliable third-party extraction.',
    );
  }

  throw new TranscriptUnavailableError(candidate.videoId, attempts, sawBlock);
}

export { SpeechToTextUnavailableError, estimateSttCostUsd, isSttConfigured } from './stt';
export { describeProviderChain, resolveProviderChain } from './providers';
export type { TranscriptProviderId } from './providers';
