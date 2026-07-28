/** ISO 8601 duration helpers for the YouTube `contentDetails.duration` field. */

const ISO_DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Parse e.g. `PT1H23M45S` into seconds. Returns 0 for unparseable input. */
export function parseIsoDuration(value: string | null | undefined): number {
  if (!value) return 0;

  const match = ISO_DURATION.exec(value.trim());
  if (!match) return 0;

  const [, years, months, weeks, days, hours, minutes, seconds] = match;

  return (
    Number(years ?? 0) * 31_536_000 +
    Number(months ?? 0) * 2_592_000 +
    Number(weeks ?? 0) * 604_800 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

/** `3725` -> `1:02:05`. Used for clip timecodes in the UI and exports. */
export function formatTimecode(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  const paddedSeconds = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

/** `3725` -> `1h 2m`. For episode durations. */
export function formatDurationLabel(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${safe % 60}s`;
  return `${safe}s`;
}

/**
 * Frame-accurate timecode for NLE exports (EDL / FCPXML in a later milestone).
 * `HH:MM:SS:FF` at the supplied frame rate.
 */
export function formatSmpteTimecode(totalSeconds: number, fps = 30): string {
  const safe = Math.max(0, totalSeconds);
  const whole = Math.floor(safe);
  const frames = Math.min(fps - 1, Math.floor((safe - whole) * fps));

  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;

  return [hours, minutes, seconds, frames]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/** Build a deep link that opens the episode at the clip's start time. */
export function youtubeTimestampUrl(videoId: string, startSec: number): string {
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(startSec))}s`;
}
