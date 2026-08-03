import { describe, it, expect } from 'vitest';
import { repairBoundary } from '@/lib/moments/boundary-repair';
import type { EnrichedSentence } from '@/lib/moments/utterances';

function u(start: number, end: number, text: string, opts: Partial<EnrichedSentence> = {}): EnrichedSentence {
  return {
    id: `u-${start}`,
    startSec: start,
    endSec: end,
    text,
    wordCount: text.split(/\s+/).length,
    speakerId: null,
    pauseBeforeSec: 0,
    pauseAfterSec: 0,
    isCompleteSentence: /[.!?…]$/.test(text),
    startsWithTransition: false,
    startsWithQuestion: false,
    endsWithQuestion: /\?$/.test(text),
    semanticTopicId: null,
    sourceCueStartIndex: 0,
    sourceCueEndIndex: 0,
    ...opts,
  };
}

describe('repairBoundary (brief §12)', () => {
  it('truncates to the last complete ending before the next topic', () => {
    const utterances = [
      u(0, 5, 'The first reason is clear.'),
      u(5, 10, 'The second reason is even bigger.'),
      u(10, 12, 'How was your childhood?', { startsWithQuestion: true, pauseBeforeSec: 0.8 }),
    ];
    const r = repairBoundary(utterances, { roughStartSec: 0, roughEndSec: 12 });
    expect(r.boundaryStatus).toBe('repaired');
    expect(r.finalEndSec).toBeLessThanOrEqual(10);
  });

  it('keeps the boundary when it is already acceptable', () => {
    const utterances = [
      u(0, 5, 'The product failed.'),
      u(5, 9, 'We expanded too fast.'),
    ];
    const r = repairBoundary(utterances, { roughStartSec: 0, roughEndSec: 9 });
    expect(['repaired', 'refined']).toContain(r.boundaryStatus);
    expect(r.finalEndSec).toBeLessThanOrEqual(9);
  });

  it('extends to a complete answer when the response is unfinished', () => {
    const utterances = [
      u(0, 4, 'The biggest reason is because'),
      u(4, 8, 'we never validated the market before scaling.'),
    ];
    const r = repairBoundary(utterances, { roughStartSec: 0, roughEndSec: 4 });
    expect(r.boundaryStatus).toBe('repaired');
    expect(r.finalEndSec).toBeGreaterThan(4);
    expect(r.needsRefinementRetry).toBe(true);
  });

  it('rejects when no complete idea exists', () => {
    const utterances = [
      u(0, 3, 'so basically'),
      u(3, 6, 'and then it was like'),
    ];
    const r = repairBoundary(utterances, { roughStartSec: 0, roughEndSec: 6 });
    expect(r.boundaryStatus).toBe('rejected');
  });
});
