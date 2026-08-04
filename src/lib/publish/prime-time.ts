/**
 * Prime-time scheduling for scheduled publish.
 *
 * Rotates clips across target markets (US / AU / CH) at fixed proportions and
 * computes the next prime-time slot for each market in its own timezone,
 * DST-aware, with no external dependency.
 */

export type PrimeRegion = 'us' | 'au' | 'ch';

export interface PrimeRegionConfig {
  /** IANA timezone the local clock is defined in. */
  timeZone: string;
  /** Local wall-clock hour (0-23) of the prime slot. */
  hour: number;
  /** Local wall-clock minute (0-59), default 0. */
  minute: number;
}

/** Region → human label shown in the UI / notifications. */
export const PRIME_REGION_LABELS: Record<PrimeRegion, string> = {
  us: 'US',
  au: 'Australia',
  ch: 'Switzerland',
};

/**
 * Weighted rotation template for 20 clips: 12× US (60%), 5× AU (25%),
 * 3× CH (15%). `assignPrimeRegion(index)` picks the market for the
 * 0-based index of a clip within a scheduled batch.
 */
const ROTATION_TEMPLATE: PrimeRegion[] = [
  'us', 'us', 'au', 'us', 'ch',
  'us', 'au', 'us', 'us', 'ch',
  'au', 'us', 'us', 'us', 'ch',
  'us', 'au', 'us', 'au', 'us',
];

export function assignPrimeRegion(index: number): PrimeRegion {
  return ROTATION_TEMPLATE[((index % ROTATION_TEMPLATE.length) + ROTATION_TEMPLATE.length) % ROTATION_TEMPLATE.length]!;
}

/**
 * Compute the next UTC instant whose local wall clock in `timeZone` equals
 * `hour:minute`. Brute-forces forward minute-by-minute for up to 8 days,
 * which is cheap (a few thousand Intl calls) and immune to DST transitions.
 */
export function nextPrimeUtc(config: PrimeRegionConfig, from: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);

  const maxMinutes = 8 * 24 * 60;
  for (let i = 0; i < maxMinutes; i += 1) {
    const candidate = new Date(cursor.getTime() + i * 60_000);
    if (candidate.getTime() <= from.getTime()) continue;

    const parts = formatter.formatToParts(candidate);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    if (h === config.hour && m === config.minute) {
      return candidate.toISOString();
    }
  }

  // Safety fallback: prime slot one week from now at the same wall clock.
  const fallback = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  fallback.setUTCSeconds(0, 0);
  return fallback.toISOString();
}
