import type { Transcript, TranscriptCue, TranscriptSource } from '@/lib/domain/types';

/**
 * Caption track extraction.
 *
 * YouTube's Data API can tell us a caption track *exists* (`captions.list`) but
 * downloading its contents through the API requires OAuth as the video's owner,
 * which we will never have for third-party podcasts. The practical route is the
 * `timedtext` endpoint referenced by the watch page's player response.
 *
 * That is an internal endpoint, so this module treats failure as normal: every
 * error path returns `null` with a reason rather than throwing, and the caller
 * falls back to speech-to-text.
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface CaptionFetchResult {
  transcript: Transcript | null;
  reason: string | null;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string };
}

interface Json3Response {
  events?: {
    tStartMs?: number;
    dDurationMs?: number;
    segs?: { utf8?: string }[];
  }[];
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
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Pick the best available track: a human-authored track in a preferred
 * language beats an ASR track, and any preferred-language track beats a
 * foreign one.
 */
function pickTrack(tracks: CaptionTrack[], preferredLanguages: string[]): CaptionTrack | null {
  if (tracks.length === 0) return null;

  const normalised = preferredLanguages.map((language) => language.toLowerCase());

  const matchesLanguage = (track: CaptionTrack): boolean => {
    const code = track.languageCode.toLowerCase();
    return normalised.some((language) => code === language || code.startsWith(`${language}-`) || language.startsWith(code));
  };

  const manualPreferred = tracks.find((track) => track.kind !== 'asr' && matchesLanguage(track));
  if (manualPreferred) return manualPreferred;

  const asrPreferred = tracks.find((track) => track.kind === 'asr' && matchesLanguage(track));
  if (asrPreferred) return asrPreferred;

  const anyManual = tracks.find((track) => track.kind !== 'asr');
  return anyManual ?? tracks[0] ?? null;
}

function json3ToCues(payload: Json3Response): TranscriptCue[] {
  const cues: TranscriptCue[] = [];

  for (const event of payload.events ?? []) {
    const text = (event.segs ?? [])
      .map((segment) => segment.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length === 0 || text === '\n') continue;

    const startSec = (event.tStartMs ?? 0) / 1000;
    const durationSec = (event.dDurationMs ?? 0) / 1000;

    cues.push({
      startSec: Math.round(startSec * 100) / 100,
      endSec: Math.round((startSec + durationSec) * 100) / 100,
      text,
    });
  }

  return cues;
}

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
      return { transcript: null, reason: `Watch page returned ${response.status}` };
    }
    html = await response.text();
  } catch (error) {
    return {
      transcript: null,
      reason: `Watch page fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }

  const raw = extractJsonAfter(html, 'ytInitialPlayerResponse');
  if (!raw) {
    return { transcript: null, reason: 'Player response not present in watch page markup' };
  }

  let playerResponse: {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
    videoDetails?: { lengthSeconds?: string };
  };

  try {
    playerResponse = JSON.parse(raw);
  } catch {
    return { transcript: null, reason: 'Player response was not valid JSON' };
  }

  const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickTrack(tracks, preferredLanguages);

  if (!track?.baseUrl) {
    return { transcript: null, reason: 'No caption track available for this video' };
  }

  let payload: Json3Response;
  try {
    const captionUrl = new URL(track.baseUrl);
    captionUrl.searchParams.set('fmt', 'json3');

    const response = await fetch(captionUrl, {
      headers: { 'user-agent': USER_AGENT },
      cache: 'no-store',
      signal,
    });

    if (!response.ok) {
      return { transcript: null, reason: `Caption download returned ${response.status}` };
    }
    payload = (await response.json()) as Json3Response;
  } catch (error) {
    return {
      transcript: null,
      reason: `Caption download failed: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }

  const cues = json3ToCues(payload);
  if (cues.length === 0) {
    return { transcript: null, reason: 'Caption track was empty' };
  }

  const source: TranscriptSource = track.kind === 'asr' ? 'youtube_asr' : 'youtube_manual';
  const lastCue = cues[cues.length - 1]!;
  const wordCount = cues.reduce((total, cue) => total + cue.text.split(/\s+/).length, 0);

  return {
    transcript: {
      videoId,
      source,
      language: track.languageCode,
      cues,
      durationSec: Math.round(lastCue.endSec),
      wordCount,
    },
    reason: null,
  };
}
