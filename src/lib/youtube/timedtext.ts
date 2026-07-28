import type { TranscriptCue } from '@/lib/domain/types';

/**
 * YouTube `timedtext` json3 format.
 *
 * Shared because two different acquisition paths produce the same payload: the
 * direct watch-page scrape in `captions.ts` and the yt-dlp provider. Parsing it
 * in one place keeps cue timing identical regardless of how the file arrived.
 */

export interface Json3Response {
  events?: {
    tStartMs?: number;
    dDurationMs?: number;
    segs?: { utf8?: string }[];
  }[];
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** `asr` for auto-generated tracks; absent for human-authored ones. */
  kind?: string;
  name?: { simpleText?: string };
}

export function json3ToCues(payload: Json3Response): TranscriptCue[] {
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

/**
 * Pick the best available track: a human-authored track in a preferred language
 * beats an ASR track, and any preferred-language track beats a foreign one.
 */
export function pickCaptionTrack(
  tracks: readonly CaptionTrack[],
  preferredLanguages: readonly string[],
): CaptionTrack | null {
  if (tracks.length === 0) return null;

  const normalised = preferredLanguages.map((language) => language.toLowerCase());

  const matchesLanguage = (track: CaptionTrack): boolean => {
    const code = track.languageCode.toLowerCase();
    return normalised.some(
      (language) =>
        code === language || code.startsWith(`${language}-`) || language.startsWith(code),
    );
  };

  return (
    tracks.find((track) => track.kind !== 'asr' && matchesLanguage(track)) ??
    tracks.find((track) => track.kind === 'asr' && matchesLanguage(track)) ??
    tracks.find((track) => track.kind !== 'asr') ??
    tracks[0] ??
    null
  );
}

/** Language codes yt-dlp writes for auto-generated tracks, e.g. `en-orig`. */
export function isOriginalLanguageTrack(languageCode: string): boolean {
  return languageCode.endsWith('-orig');
}

export function cueStats(cues: readonly TranscriptCue[]): {
  wordCount: number;
  durationSec: number;
} {
  const last = cues[cues.length - 1];
  return {
    wordCount: cues.reduce((total, cue) => total + cue.text.split(/\s+/).filter(Boolean).length, 0),
    durationSec: last ? Math.round(last.endSec) : 0,
  };
}
