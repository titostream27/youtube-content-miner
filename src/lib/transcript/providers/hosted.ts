import { config } from '@/lib/config';
import type { Transcript, TranscriptCue } from '@/lib/domain/types';
import { cueStats } from '@/lib/youtube/timedtext';
import {
  attemptFailed,
  attemptSucceeded,
  type TranscriptAttempt,
  type TranscriptFetchInput,
  type TranscriptProvider,
} from './types';

/**
 * Hosted transcript vendor adapter.
 *
 * For a cloud deployment this is the pragmatic answer to YouTube's anti-bot
 * layer: the vendor maintains the residential proxy pool and tracks
 * proof-of-origin token changes, and charges a fraction of a cent per video.
 * That is dramatically cheaper than speech-to-text and removes an entire class
 * of operational work.
 *
 * Deliberately vendor-neutral. Every provider in this space (Supadata,
 * transcriptapi.com, SearchApi, Apify actors, and others) exposes the same
 * shape: GET a URL with a video id, receive timed segments. Rather than pick a
 * winner, the request is described by environment variables and the response is
 * normalised tolerantly - so switching vendor is a config change, not a code
 * change.
 */

/** Segment field aliases seen across vendors. */
interface LooseSegment {
  text?: unknown;
  content?: unknown;
  start?: unknown;
  offset?: unknown;
  start_ms?: unknown;
  startMs?: unknown;
  startTime?: unknown;
  duration?: unknown;
  dur?: unknown;
  duration_ms?: unknown;
  durationMs?: unknown;
  end?: unknown;
  end_ms?: unknown;
  endMs?: unknown;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Vendors disagree on whether times are seconds or milliseconds and rarely
 * document it. Field name is the reliable signal; magnitude is the fallback -
 * a start time of 480000 is milliseconds, not a 5-day-long podcast.
 */
function toSeconds(value: number, fieldName: string): number {
  if (/ms$/i.test(fieldName) || /_ms$/i.test(fieldName)) return value / 1000;
  return value > 100_000 ? value / 1000 : value;
}

function readTime(segment: LooseSegment, keys: readonly (keyof LooseSegment)[]): number | null {
  for (const key of keys) {
    const parsed = asNumber(segment[key]);
    if (parsed !== null) return toSeconds(parsed, String(key));
  }
  return null;
}

/** Pull the segment array out of whatever envelope the vendor used. */
function findSegments(payload: unknown): LooseSegment[] | null {
  if (Array.isArray(payload)) return payload as LooseSegment[];

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['segments', 'transcript', 'content', 'data', 'results', 'items', 'chunks']) {
      const value = record[key];
      if (Array.isArray(value)) return value as LooseSegment[];
      // One level of nesting, e.g. { data: { transcript: [...] } }.
      if (value && typeof value === 'object') {
        const nested = findSegments(value);
        if (nested) return nested;
      }
    }
  }

  return null;
}

function normaliseSegments(segments: readonly LooseSegment[]): TranscriptCue[] {
  const cues: TranscriptCue[] = [];

  for (const segment of segments) {
    const rawText = typeof segment.text === 'string' ? segment.text : segment.content;
    const text = typeof rawText === 'string' ? rawText.replace(/\s+/g, ' ').trim() : '';
    if (text.length === 0) continue;

    const start = readTime(segment, ['start', 'offset', 'start_ms', 'startMs', 'startTime']);
    if (start === null) continue;

    const duration = readTime(segment, ['duration', 'dur', 'duration_ms', 'durationMs']);
    const end = readTime(segment, ['end', 'end_ms', 'endMs']);

    // Fall back to a speech-rate estimate when neither duration nor end exists,
    // so a vendor that omits both still yields usable segment boundaries.
    const resolvedEnd =
      end ?? (duration !== null ? start + duration : start + text.split(/\s+/).length / 2.6);

    cues.push({
      startSec: Math.round(start * 100) / 100,
      endSec: Math.round(resolvedEnd * 100) / 100,
      text,
    });
  }

  return cues.sort((a, b) => a.startSec - b.startSec);
}

function buildUrl(template: string, videoId: string): string {
  if (template.includes('{videoId}')) {
    return template.replace('{videoId}', encodeURIComponent(videoId));
  }

  const target = new URL(template);
  target.searchParams.set(config.transcript.hosted.videoIdParam, videoId);
  return target.toString();
}

export const hostedProvider: TranscriptProvider = {
  id: 'hosted',

  async fetch(input: TranscriptFetchInput): Promise<TranscriptAttempt> {
    const { hosted } = config.transcript;
    if (!hosted.url) return attemptFailed('hosted', 'TRANSCRIPT_API_URL is not set');

    const headers: Record<string, string> = { accept: 'application/json' };
    if (hosted.apiKey) {
      headers[hosted.authHeader] = hosted.authScheme
        ? `${hosted.authScheme} ${hosted.apiKey}`
        : hosted.apiKey;
    }

    let response: Response;
    try {
      response = await fetch(buildUrl(hosted.url, input.candidate.videoId), {
        headers,
        cache: 'no-store',
        signal: input.signal ?? AbortSignal.timeout(hosted.timeoutMs),
      });
    } catch (error) {
      return attemptFailed(
        'hosted',
        `request failed: ${error instanceof Error ? error.message : 'unknown'}`,
        true,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return attemptFailed(
        'hosted',
        `vendor returned ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`,
        response.status === 429 || response.status >= 500,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return attemptFailed('hosted', 'vendor response was not JSON');
    }

    const segments = findSegments(payload);
    if (!segments) {
      return attemptFailed(
        'hosted',
        'could not locate a segment array in the vendor response - check the response shape',
      );
    }

    const cues = normaliseSegments(segments);
    if (cues.length === 0) {
      return attemptFailed('hosted', 'vendor returned no usable segments');
    }

    const stats = cueStats(cues);
    const transcript: Transcript = {
      videoId: input.candidate.videoId,
      // Vendors serve YouTube's own caption track, which is usually ASR. We
      // cannot tell manual from auto, so we assume the lower-fidelity case -
      // that keeps confidence honest rather than optimistic.
      source: 'youtube_asr',
      language: input.preferredLanguages[0] ?? 'en',
      cues,
      durationSec: stats.durationSec,
      wordCount: stats.wordCount,
    };

    return attemptSucceeded('hosted', transcript);
  },
};
