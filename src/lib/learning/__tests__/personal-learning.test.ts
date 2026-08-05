import { describe, it, expect } from 'vitest';
import {
  buildPersonalLearningReport,
  hookTypeOf,
  durationBandOf,
  postingHourOf,
  acceptancePrior,
  type LearningSample,
} from '@/lib/learning/personal-learning';

function s(overrides: Partial<LearningSample> = {}): LearningSample {
  return {
    clipId: 1,
    channelTitle: 'Founders Off Record',
    mainTopic: 'startup growth',
    suggestedHook: 'Why most startups fail',
    durationSec: 45,
    publishedAt: '2026-07-01T14:00:00Z',
    verdict: 'approved',
    ...overrides,
  };
}

describe('personal learning (Phase 2)', () => {
  it('classifies hook types', () => {
    expect(hookTypeOf('Why most startups fail')).toBe('question');
    expect(hookTypeOf('We made $2 million in a year')).toBe('number');
    expect(hookTypeOf('The secret nobody tells you')).toBe('shock');
    expect(hookTypeOf('Plain statement here')).toBe('other');
    expect(hookTypeOf('')).toBeNull();
  });

  it('classifies duration bands', () => {
    expect(durationBandOf(15)).toBe('<20s');
    expect(durationBandOf(30)).toBe('20-35s');
    expect(durationBandOf(45)).toBe('35-60s');
    expect(durationBandOf(90)).toBe('60s+');
  });

  it('extracts posting hour (UTC)', () => {
    expect(postingHourOf('2026-07-01T14:30:00Z')).toBe('14:00');
    expect(postingHourOf(null)).toBeNull();
    expect(postingHourOf('garbage')).toBeNull();
  });

  it('acceptancePrior smooths small samples toward 50%', () => {
    expect(acceptancePrior(0, 0)).toBe(0.5);
    expect(acceptancePrior(1, 1)).toBeCloseTo((1 + 1) / (1 + 2), 6); // 2/3
    expect(acceptancePrior(10, 10)).toBeCloseTo(11 / 12, 6); // 0.917
  });

  it('builds per-channel and per-duration priors', () => {
    const samples = [
      s({ clipId: 1, channelTitle: 'ChanA', mainTopic: 'growth', suggestedHook: 'Why X', durationSec: 30, verdict: 'approved' }),
      s({ clipId: 2, channelTitle: 'ChanA', mainTopic: 'growth', suggestedHook: 'Why Y', durationSec: 30, verdict: 'rejected' }),
      s({ clipId: 3, channelTitle: 'ChanB', mainTopic: 'crypto', suggestedHook: 'The secret of Z', durationSec: 90, verdict: 'approved' }),
    ];
    const r = buildPersonalLearningReport(samples);
    expect(r.totalLabelled).toBe(3);
    expect(r.overallPrior).toBeCloseTo((2 + 1) / (3 + 2), 6); // 0.6
    const chanA = r.byChannel.find((c) => c.key === 'ChanA')!;
    expect(chanA.labelled).toBe(2);
    expect(chanA.approved).toBe(1);
    expect(chanA.acceptancePrior).toBeCloseTo((1 + 1) / (2 + 2), 6); // 0.5
    const band = r.byDurationBand.find((b) => b.key === '<20s');
    expect(band).toBeUndefined();
    expect(r.byDurationBand.find((b) => b.key === '20-35s')!.labelled).toBe(2);
    expect(r.byDurationBand.find((b) => b.key === '60s+')!.labelled).toBe(1);
    expect(r.byHookType.find((h) => h.key === 'question')!.labelled).toBe(2);
    expect(r.byPostingHour.find((h) => h.key === '14:00')!.labelled).toBe(3);
  });
});
