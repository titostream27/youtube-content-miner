import { describe, it, expect } from 'vitest';
import { assignPrimeRegion, nextPrimeUtc } from '@/lib/publish/prime-time';

describe('assignPrimeRegion — weighted rotation 60/25/15', () => {
  it('keeps the template proportions over 20 clips', () => {
    const counts = { us: 0, au: 0, ch: 0 };
    for (let i = 0; i < 20; i += 1) {
      counts[assignPrimeRegion(i)] += 1;
    }
    expect(counts.us).toBe(12); // 60%
    expect(counts.au).toBe(5); // 25%
    expect(counts.ch).toBe(3); // 15%
  });

  it('repeats deterministically after the template', () => {
    expect(assignPrimeRegion(0)).toBe(assignPrimeRegion(20));
    expect(assignPrimeRegion(1)).toBe(assignPrimeRegion(21));
  });
});

describe('nextPrimeUtc', () => {
  it('returns a future instant matching the wall clock in the target tz', () => {
    // Europe/Zurich 07:00 local → must be 06:00 UTC (CET, no DST in August 2026).
    const from = new Date('2026-08-04T00:00:00.000Z'); // UTC midnight
    const iso = nextPrimeUtc({ timeZone: 'Europe/Zurich', hour: 7, minute: 0 }, from);
    const d = new Date(iso);
    expect(d.getTime()).toBeGreaterThan(from.getTime());
    expect(d.toISOString().startsWith('2026-08-04T05')).toBe(true); // 07:00 CEST = 05:00 UTC
  });

  it('rolls to the next day when today slot already passed', () => {
    const from = new Date('2026-08-04T20:00:00.000Z'); // 22:00 Zurich CEST
    const iso = nextPrimeUtc({ timeZone: 'Europe/Zurich', hour: 7, minute: 0 }, from);
    expect(new Date(iso).getTime()).toBeGreaterThan(from.getTime());
    expect(new Date(iso).toISOString().startsWith('2026-08-05T05')).toBe(true);
  });

  it('is DST-aware via IANA zones (US Eastern)', () => {
    // New York 08:00 local. In August 2026 (EDT, UTC-4) → 12:00 UTC.
    const from = new Date('2026-08-04T00:00:00.000Z');
    const iso = nextPrimeUtc({ timeZone: 'America/New_York', hour: 8, minute: 0 }, from);
    expect(new Date(iso).toISOString().startsWith('2026-08-04T12')).toBe(true);
  });
});
