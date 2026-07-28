import type { EpisodeCandidate, Transcript } from '@/lib/domain/types';

/**
 * Transcript acquisition is a pluggable chain rather than one hard-coded path.
 *
 * The reason is empirical: no single method works everywhere. Measured from a
 * datacenter IP, the direct watch-page scrape gets a zero-byte refusal, yt-dlp's
 * default clients refuse without a proof-of-origin token, and its `android`
 * client succeeds intermittently before hitting rate limits. A hosted vendor
 * absorbs all of that for a fraction of a cent per video.
 *
 * Which trade-off is right depends entirely on the deployment - local dev,
 * self-hosted on a residential connection, or a cloud host - so the order is
 * configuration, not code.
 */

export type TranscriptProviderId = 'hosted' | 'ytdlp' | 'captions' | 'stt';

export interface TranscriptFetchInput {
  candidate: EpisodeCandidate;
  preferredLanguages: string[];
  signal?: AbortSignal;
}

export interface TranscriptAttempt {
  provider: TranscriptProviderId;
  transcript: Transcript | null;
  /** Why it failed. Null on success. */
  reason: string | null;
  /**
   * True when the failure is anti-bot enforcement rather than the transcript
   * genuinely not existing. The chain uses this to distinguish "this video has
   * no captions" from "we were blocked", which are completely different
   * problems for whoever has to fix it.
   */
  blocked: boolean;
}

/** The behaviour half: just fetching. */
export interface TranscriptProvider {
  readonly id: TranscriptProviderId;
  fetch(input: TranscriptFetchInput): Promise<TranscriptAttempt>;
}

/**
 * The metadata half: identity and availability, resolvable from configuration
 * alone.
 *
 * Split from the provider itself so that reading chain *status* never loads the
 * implementations. The yt-dlp provider spawns a subprocess and touches the
 * filesystem; pulling that into a route that only wants to render a status panel
 * drags the whole module graph along with it.
 */
export interface TranscriptProviderDescriptor {
  readonly id: TranscriptProviderId;
  readonly label: string;
  /** Human-readable reason this provider cannot run, or null when ready. */
  unavailableReason(): string | null;
  /** Loaded on first use only. */
  load(): Promise<TranscriptProvider>;
}

export function attemptFailed(
  provider: TranscriptProviderId,
  reason: string,
  blocked = false,
): TranscriptAttempt {
  return { provider, transcript: null, reason, blocked };
}

export function attemptSucceeded(
  provider: TranscriptProviderId,
  transcript: Transcript,
): TranscriptAttempt {
  return { provider, transcript, reason: null, blocked: false };
}
