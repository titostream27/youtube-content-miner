import { describe, it, expect } from 'vitest';
import { validateStartBoundary } from '@/lib/moments/start-boundary';
import type { EnrichedSentence } from '@/lib/moments/utterances';

function u(
  id: string,
  startSec: number,
  endSec: number,
  text: string,
): EnrichedSentence {
  return {
    id,
    startSec,
    endSec,
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    speakerId: null,
    pauseBeforeSec: 0,
    pauseAfterSec: 0,
    isCompleteSentence: true,
    startsWithTransition: false,
    startsWithQuestion: false,
    endsWithQuestion: false,
    semanticTopicId: null,
    sourceCueStartIndex: 0,
    sourceCueEndIndex: 0,
  };
}

describe('validateStartBoundary (Phase 2 start validation)', () => {
  it('accepts a clean self-contained opening', () => {
    const utts = [
      u('s1', 10.0, 12.0, 'Most companies fail because they scale too fast.'),
      u('s2', 12.2, 15.0, 'We saw this with three startups last year.'),
    ];
    const r = validateStartBoundary(utts, 10.0, 15.0);
    expect(r.startComplete).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('flags MID_SENTENCE for a lowercase continuation opener', () => {
    const utts = [
      u('s1', 10.0, 12.0, 'because they scaled before the product was ready'),
      u('s2', 12.2, 15.0, 'and that killed the whole company.'),
    ];
    const r = validateStartBoundary(utts, 10.0, 15.0);
    expect(r.startComplete).toBe(false);
    expect(r.issues).toContain('MID_SENTENCE');
  });

  it('flags MISSING_CONTEXT for a referential opener with no referent', () => {
    const utts = [
      u('s1', 10.0, 12.0, 'This decision destroyed their growth.'),
    ];
    const r = validateStartBoundary(utts, 10.0, 12.0);
    expect(r.startComplete).toBe(false);
    expect(r.issues).toContain('MISSING_CONTEXT');
  });

  it('flags UNRESOLVED_REFERENCE for a pronoun opener', () => {
    const utts = [
      u('s1', 10.0, 12.0, 'He then raised the valuation.'),
    ];
    const r = validateStartBoundary(utts, 10.0, 12.0);
    expect(r.startComplete).toBe(false);
    expect(r.issues).toContain('UNRESOLVED_REFERENCE');
  });

  it('flags LATE_HOOK when the first hook signal arrives too late', () => {
    const utts = [
      u('s1', 10.0, 13.0, 'And then we talked about the schedule.'),
      u('s2', 13.2, 16.0, 'We also covered the budget details.'),
      u('s3', 16.2, 19.0, 'And the timeline was discussed too.'),
      u('s4', 30.0, 33.0, 'But the company was actually bankrupt.'),
    ];
    const r = validateStartBoundary(utts, 10.0, 33.0, { lateHookSec: 8 });
    expect(r.startComplete).toBe(false);
    expect(r.issues).toContain('LATE_HOOK');
    expect(r.hookDelaySec).toBeGreaterThanOrEqual(20);
  });

  it('returns missing-context for an empty window', () => {
    const r = validateStartBoundary([], 10.0, 15.0);
    expect(r.startComplete).toBe(false);
    expect(r.issues).toContain('MISSING_CONTEXT');
  });
});
