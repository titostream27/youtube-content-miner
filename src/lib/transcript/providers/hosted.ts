import { config } from '@/lib/config';
import type { Transcript, TranscriptCue } from '@/lib/domain/types';
import { cueStats } from '@/lib/youtube/timedtext';
import {
  resolveTranscriptVendor,
  type ResolvedTranscriptVendor,
} from '@/lib/settings/transcript-vendor';
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
 * proof-of-origin token changes, and charges a fraction of a cent per video -
 * dramatically cheaper than speech-to-text and it removes an entire class of
 * operational work.
 *
 * Vendor-neutral by design. The request and response contract comes from the
 * preset in `transcript/vendors.ts`, so switching vendor is configuration rather
 * than code.
 *
 * Two behaviours here exist because of things that would otherwise break
 * silently on real podcast episodes:
 *
 *   - Time units are read from the vendor declaration, never inferred from
 *     magnitude. See the note in `vendors.ts`.
 *   - Long videos are frequently answered with a job id rather than a
 *     transcript. Since long videos *are* the workload, job polling is a
 *     first-class path, not an afterthought.
 */

/** Segment field aliases seen across vendors. */
interface LooseSegment {
  text?: unknown;
  content?: unknown;
  start?: unknown;
  offset?: unknown;
  startTime?: unknown;
  duration?: unknown;
  dur?: unknown;
  end?: unknown;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readTime(
  segment: LooseSegment,
  keys: readonly (keyof LooseSegment)[],
  timeUnit: 'ms' | 's',
): number | null {
  for (const key of keys) {
    const parsed = asNumber(segment[key]);
    if (parsed !== null) return timeUnit === 'ms' ? parsed / 1000 : parsed;
  }
  return null;
}

/** Pull the segment array out of whatever envelope the vendor used. */
function findSegments(payload: unknown, depth = 0): LooseSegment[] | null {
  if (Array.isArray(payload)) return payload as LooseSegment[];
  if (depth > 3 || !payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  for (const key of [
    'content',
    'segments',
    'transcript',
    'data',
    'results',
    'items',
    'chunks',
  ]) {
    const value = record[key];
    if (Array.isArray(value)) return value as LooseSegment[];
    if (value && typeof value === 'object') {
      const nested = findSegments(value, depth + 1);
      if (nested) return nested;
    }
  }

  return null;
}

export function normaliseSegments(
  segments: readonly LooseSegment[],
  timeUnit: 'ms' | 's',
): TranscriptCue[] {
  const cues: TranscriptCue[] = [];

  for (const segment of segments) {
    const rawText = typeof segment.text === 'string' ? segment.text : segment.content;
    const text = typeof rawText === 'string' ? rawText.replace(/\s+/g, ' ').trim() : '';
    if (text.length === 0) continue;

    const start = readTime(segment, ['start', 'offset', 'startTime'], timeUnit);
    if (start === null) continue;

    const duration = readTime(segment, ['duration', 'dur'], timeUnit);
    const end = readTime(segment, ['end'], timeUnit);

    // Fall back to a speech-rate estimate when neither duration nor end exists,
    // so a vendor that omits both still yields usable boundaries.
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

function buildUrl(vendor: ResolvedTranscriptVendor, videoId: string): string {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const template = vendor.urlTemplate;

  if (template.includes('{videoUrl}')) {
    return template.replace('{videoUrl}', encodeURIComponent(videoUrl));
  }
  if (template.includes('{videoId}')) {
    return template.replace('{videoId}', encodeURIComponent(videoId));
  }

  const target = new URL(template);
  target.searchParams.set(config.transcript.hosted.videoIdParam, videoId);
  return target.toString();
}

function authHeaders(vendor: ResolvedTranscriptVendor): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };

  if (vendor.apiKey) {
    headers[vendor.authHeader] = vendor.authScheme
      ? `${vendor.authScheme} ${vendor.apiKey}`
      : vendor.apiKey;
  }

  return headers;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface VendorFetchOutcome {
  cues: TranscriptCue[] | null;
  reason: string | null;
  blocked: boolean;
  /** True when the transcript arrived via a polled job rather than immediately. */
  viaJob: boolean;
  language: string | null;
}

/**
 * Perform the vendor request, following an asynchronous job to completion when
 * the vendor answers with one. Exported so the settings connection test can
 * exercise exactly the same path the pipeline uses.
 */
export async function fetchFromVendor(params: {
  vendor: ResolvedTranscriptVendor;
  videoId: string;
  signal?: AbortSignal;
}): Promise<VendorFetchOutcome> {
  const { vendor, videoId, signal } = params;
  const headers = authHeaders(vendor);

  const request = async (url: string): Promise<{ payload: unknown } | VendorFetchOutcome> => {
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        cache: 'no-store',
        signal: signal ?? AbortSignal.timeout(config.transcript.hosted.timeoutMs),
      });
    } catch (error) {
      return {
        cues: null,
        reason: `request failed: ${error instanceof Error ? error.message : 'unknown'}`,
        blocked: true,
        viaJob: false,
        language: null,
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        cues: null,
        reason:
          `vendor returned ${response.status}` +
          (response.status === 401 || response.status === 403
            ? ' - check the API key'
            : response.status === 402
              ? ' - out of credits'
              : '') +
          (body ? `: ${body.slice(0, 200)}` : ''),
        blocked: response.status === 429 || response.status >= 500,
        viaJob: false,
        language: null,
      };
    }

    try {
      return { payload: (await response.json()) as unknown };
    } catch {
      return {
        cues: null,
        reason: 'vendor response was not JSON',
        blocked: false,
        viaJob: false,
        language: null,
      };
    }
  };

  const initial = await request(buildUrl(vendor, videoId));
  if (!('payload' in initial)) return initial;

  const languageOf = (payload: unknown): string | null => {
    if (payload && typeof payload === 'object') {
      const value = (payload as Record<string, unknown>).lang;
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  };

  let payload = initial.payload;
  let viaJob = false;

  let segments = findSegments(payload);

  // No segments yet: the vendor may have handed back a job id instead. This is
  // the normal answer for long videos, which is the workload here.
  if (!segments && vendor.preset.response.asyncJob && vendor.pollUrlTemplate) {
    const { idField } = vendor.preset.response.asyncJob;
    const pollUrlTemplate = vendor.pollUrlTemplate;
    const record = payload as Record<string, unknown> | null;
    const jobId = record && typeof record[idField] === 'string' ? (record[idField] as string) : null;

    if (jobId) {
      viaJob = true;
      const deadline = Date.now() + config.transcript.hosted.jobTimeoutMs;
      let waitMs = 1_500;

      while (Date.now() < deadline) {
        await delay(waitMs);
        // Back off gradually; long episodes can take a while to generate.
        waitMs = Math.min(8_000, Math.round(waitMs * 1.5));

        const polled = await request(pollUrlTemplate.replace('{jobId}', encodeURIComponent(jobId)));
        if (!('payload' in polled)) return { ...polled, viaJob: true };

        payload = polled.payload;
        const record2 = payload as Record<string, unknown> | null;
        const status =
          record2 && typeof record2.status === 'string' ? record2.status.toLowerCase() : null;

        if (status === 'failed' || status === 'error') {
          return {
            cues: null,
            reason: `vendor job ${jobId} failed`,
            blocked: false,
            viaJob: true,
            language: null,
          };
        }

        segments = findSegments(payload);
        if (segments) break;
      }

      if (!segments) {
        return {
          cues: null,
          reason: `vendor job ${jobId} did not complete within ${Math.round(
            config.transcript.hosted.jobTimeoutMs / 1000,
          )}s`,
          blocked: false,
          viaJob: true,
          language: null,
        };
      }
    }
  }

  if (!segments) {
    return {
      cues: null,
      reason:
        'could not locate a segment array in the vendor response - check the response shape and, ' +
        'if the vendor returns plain text only, request timed segments instead',
      blocked: false,
      viaJob,
      language: null,
    };
  }

  const cues = normaliseSegments(segments, vendor.timeUnit);
  if (cues.length === 0) {
    return {
      cues: null,
      reason: 'vendor returned segments but none had usable text and timing',
      blocked: false,
      viaJob,
      language: null,
    };
  }

  return { cues, reason: null, blocked: false, viaJob, language: languageOf(payload) };
}

export const hostedProvider: TranscriptProvider = {
  id: 'hosted',

  async fetch(input: TranscriptFetchInput): Promise<TranscriptAttempt> {
    const vendor = resolveTranscriptVendor();
    if (!vendor) return attemptFailed('hosted', 'no transcript vendor configured');

    const outcome = await fetchFromVendor({
      vendor,
      videoId: input.candidate.videoId,
      signal: input.signal,
    });

    if (!outcome.cues) {
      return attemptFailed('hosted', outcome.reason ?? 'unavailable', outcome.blocked);
    }

    const stats = cueStats(outcome.cues);

    const transcript: Transcript = {
      videoId: input.candidate.videoId,
      /*
       * Vendors serve YouTube's own caption track and generally do not say
       * whether it was human-authored or ASR. We assume the lower-fidelity case,
       * which keeps the confidence model honest rather than optimistic.
       */
      source: 'youtube_asr',
      language: outcome.language ?? input.preferredLanguages[0] ?? 'en',
      cues: outcome.cues,
      durationSec: stats.durationSec,
      wordCount: stats.wordCount,
    };

    return attemptSucceeded('hosted', transcript);
  },
};
