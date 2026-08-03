import { describe, it, expect } from 'vitest';
import { addBoundaryFeedback, listBoundaryFeedback, countBoundaryFeedback } from '@/lib/db/repositories/feedback';

describe('boundary feedback (brief §22/§45)', () => {
  it('records a manual boundary correction and reads it back', () => {
    const fb = addBoundaryFeedback({
      clipId: 593,
      originalStartSec: 100,
      originalEndSec: 130,
      newStartSec: 102,
      newEndSec: 128,
      reason: 'cut interviewer interruption',
    });
    expect(fb.clipId).toBe(593);
    expect(fb.originalStartSec).toBe(100);
    expect(fb.newEndSec).toBe(128);
    expect(fb.feedbackId).toBeTypeOf('number');

    const list = listBoundaryFeedback(593);
    expect(list.length).toBeGreaterThanOrEqual(1);
    const latest = list[0]!;
    expect(latest.reason).toBe('cut interviewer interruption');

    expect(countBoundaryFeedback(593)).toBeGreaterThanOrEqual(1);
  });

  it('returns empty list for a clip with no feedback', () => {
    expect(listBoundaryFeedback(999999)).toEqual([]);
    expect(countBoundaryFeedback(999999)).toBe(0);
  });
});
