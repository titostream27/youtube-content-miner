/**
 * Transcript vendor presets.
 *
 * The point of this file is that choosing a vendor should mean pasting an API
 * key, not reverse-engineering a request shape. Each preset encodes the request
 * contract and - crucially - the response contract, because the two details that
 * silently corrupt a transcript are both response-side:
 *
 *   1. Time units. Several vendors report offsets in milliseconds. Guessing from
 *      magnitude fails exactly where it matters: an offset of 5000 is 5 seconds
 *      in ms, but a magnitude heuristic reads it as 5000 seconds and every clip
 *      timecode in the first 100 seconds of the episode lands in the wrong
 *      place. So the unit is declared, never inferred.
 *
 *   2. Asynchronous jobs. Long videos are the normal case for podcasts, and some
 *      vendors answer those with a job id instead of a transcript. An adapter
 *      that only understands the synchronous shape appears to work in testing on
 *      short clips and then fails on every real episode.
 *
 * Only contracts confirmed against published documentation are marked verified.
 * Anything else is `custom`, where the operator supplies the details - inventing
 * an endpoint would be worse than asking.
 */

export type TranscriptVendorId = 'supadata' | 'custom';

export interface TranscriptVendorPreset {
  id: TranscriptVendorId;
  label: string;
  docsUrl: string;
  /** True when the request and response contract was read from vendor docs. */
  verified: boolean;
  /** Free tier, for orientation only - always confirm with the vendor. */
  freeTierNote: string;
  request: {
    /**
     * Supports `{videoId}` and `{videoUrl}` placeholders. If neither is present,
     * the video id is appended as a query parameter.
     */
    urlTemplate: string;
    authHeader: string;
    /** e.g. `Bearer`. Null sends the key raw. */
    authScheme: string | null;
  };
  response: {
    /** Declared, never inferred. See the note above. */
    timeUnit: 'ms' | 's';
    /**
     * Long videos may be answered with a job id to poll. Absent when the vendor
     * is always synchronous.
     */
    asyncJob?: {
      /** Field on the initial response holding the job id. */
      idField: string;
      /** Poll URL, with `{jobId}` substituted. */
      pollUrlTemplate: string;
    };
  };
  notes: string;
}

export const TRANSCRIPT_VENDORS: readonly TranscriptVendorPreset[] = [
  {
    id: 'supadata',
    label: 'Supadata',
    docsUrl: 'https://docs.supadata.ai/api-reference/endpoint/transcript/transcript',
    verified: true,
    freeTierNote: '100 credits/month on the free tier; 1 credit per transcript.',
    request: {
      // The universal endpoint, not the YouTube-specific one - the latter is
      // marked deprecated in the docs. `mode=auto` fetches the existing caption
      // track and falls back to AI generation when none exists, which covers the
      // gap that would otherwise require building an audio pipeline.
      urlTemplate: 'https://api.supadata.ai/v1/transcript?url={videoUrl}&mode=auto',
      authHeader: 'x-api-key',
      authScheme: null,
    },
    response: {
      timeUnit: 'ms',
      asyncJob: {
        idField: 'jobId',
        pollUrlTemplate: 'https://api.supadata.ai/v1/transcript/{jobId}',
      },
    },
    notes:
      'Has an AI fallback for videos with no caption track, so it also covers the case that would otherwise need speech-to-text. Long videos are answered asynchronously with a job id.',
  },
  {
    id: 'custom',
    label: 'Custom / other vendor',
    docsUrl: '',
    verified: false,
    freeTierNote: 'Varies by vendor.',
    request: {
      urlTemplate: '',
      authHeader: 'x-api-key',
      authScheme: null,
    },
    response: {
      timeUnit: 's',
    },
    notes:
      'For any vendor returning timed segments for a video id. Supply the URL template and auth header, and set the time unit to match the vendor - getting that wrong shifts every clip timecode. Use the connection test to confirm before running a real pass.',
  },
];

export function vendorPreset(id: TranscriptVendorId): TranscriptVendorPreset {
  const preset = TRANSCRIPT_VENDORS.find((vendor) => vendor.id === id);
  if (!preset) throw new Error(`Unknown transcript vendor: ${id}`);
  return preset;
}

export function isTranscriptVendorId(value: string): value is TranscriptVendorId {
  return TRANSCRIPT_VENDORS.some((vendor) => vendor.id === value);
}
