import type { Transcript, TranscriptSource } from '@/lib/domain/types';
import {
  cueStats,
  json3ToCues,
  pickCaptionTrack,
  type CaptionTrack,
  type Json3Response,
} from './timedtext';

/**
 * Direct caption extraction from the watch page.
 *
 * The Data API can tell us a caption track *exists* (`captions.list`) but
 * downloading its contents through the API requires OAuth as the video's owner,
 * which we will never have for third-party podcasts. The practical route is the
 * `timedtext` endpoint referenced by the watch page's player response.
 *
 * That is an internal endpoint and YouTube actively defends it. Measured
 * behaviour from a datacenter IP: the track *list* is still present in the
 * markup, but the caption download returns HTTP 200 with a zero-byte body - a
 * silent refusal rather than an error status.
 *
 * So this provider is best-effort and honest about it. It is useful from
 * residential IPs and local development; in a hosted deployment the yt-dlp or
 * vendor provider should sit ahead of it in the chain. Every failure path
 * returns a specific reason so operators can tell "no captions exist" apart
 * from "we were blocked".
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface CaptionFetchResult {
  transcript: Transcript | null;
  reason: string | null;
  /** True when the failure looks like anti-bot enforcement rather than absence. */
  blocked: boolean;
}

/**
 * Extract a balanced JSON object starting at the first `{` after `marker`.
 * A plain regex cannot do this: player responses contain nested braces inside
 * string literals.
 */
function extractJsonAfter(html: string, marker: string): string | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const start = html.indexOf('{', markerIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const char = html[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }

  return null;
}

const BOT_CHECK = /sign in to confirm|are you a robot|unusual traffic|consent\.youtube/i;

export async function fetchYouTubeCaptions(params: {
  videoId: string;
  preferredLanguages: string[];
  signal?: AbortSignal;
}): Promise<CaptionFetchResult> {
  const { videoId, preferredLanguages, signal } = params;

  let html: string;
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
      },
      cache: 'no-store',
      signal,
    });

    if (!response.ok) {
      return {
        transcript: null,
        reason: `watch page returned ${response.status}`,
        blocked: response.status === 429 || response.status === 403,
      };
    }
    html = await response.text();
  } catch (error) {
    return {
      transcript: null,
      reason: `watch page fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
      blocked: false,
    };
  }

  const raw = extractJsonAfter(html, 'ytInitialPlayerResponse');
  if (!raw) {
    return {
      transcript: null,
      reason: BOT_CHECK.test(html)
        ? 'blocked: watch page served a bot check instead of a player response'
        : 'player response not present in watch page markup',
      blocked: BOT_CHECK.test(html),
    };
  }

  let playerResponse: {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
    playabilityStatus?: { status?: string; reason?: string };
  };

  try {
    playerResponse = JSON.parse(raw);
  } catch {
    return { transcript: null, reason: 'player response was not valid JSON', blocked: false };
  }

  const playability = playerResponse.playabilityStatus;
  if (playability?.status && playability.status !== 'OK') {
    return {
      transcript: null,
      reason: `playability ${playability.status}: ${playability.reason ?? 'no reason given'}`,
      blocked: /bot|sign in/i.test(playability.reason ?? ''),
    };
  }

  const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickCaptionTrack(tracks, preferredLanguages);

  if (!track?.baseUrl) {
    return {
      transcript: null,
      reason: 'no caption track available for this video',
      blocked: false,
    };
  }

  let body: string;
  try {
    const captionUrl = new URL(track.baseUrl);
    captionUrl.searchParams.set('fmt', 'json3');

    const response = await fetch(captionUrl, {
      headers: { 'user-agent': USER_AGENT },
      cache: 'no-store',
      signal,
    });

    if (!response.ok) {
      return {
        transcript: null,
        reason: `caption download returned ${response.status}`,
        blocked: response.status === 429 || response.status === 403,
      };
    }
    body = await response.text();
  } catch (error) {
    return {
      transcript: null,
      reason: `caption download failed: ${error instanceof Error ? error.message : 'unknown'}`,
      blocked: false,
    };
  }

  /*
   * The important diagnostic. A zero-length 200 is YouTube refusing the request
   * for lack of a proof-of-origin token, which is the normal outcome from a
   * datacenter IP. Reporting it as malformed JSON would send an operator
   * hunting for a parser bug that does not exist.
   */
  if (body.trim().length === 0) {
    return {
      transcript: null,
      reason:
        'blocked: caption endpoint returned an empty body (proof-of-origin token required, ' +
        'or the request came from a datacenter IP)',
      blocked: true,
    };
  }

  let payload: Json3Response;
  try {
    payload = JSON.parse(body) as Json3Response;
  } catch {
    return {
      transcript: null,
      reason: 'caption body was not json3',
      blocked: BOT_CHECK.test(body),
    };
  }

  const cues = json3ToCues(payload);
  if (cues.length === 0) {
    return { transcript: null, reason: 'caption track contained no cues', blocked: false };
  }

  const source: TranscriptSource = track.kind === 'asr' ? 'youtube_asr' : 'youtube_manual';
  const stats = cueStats(cues);

  return {
    transcript: {
      videoId,
      source,
      language: track.languageCode,
      cues,
      durationSec: stats.durationSec,
      wordCount: stats.wordCount,
    },
    reason: null,
    blocked: false,
  };
}
