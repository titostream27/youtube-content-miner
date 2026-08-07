/** Brief v11 C7/C8 — canonical final transcript provenance. */
import { describe, expect, it } from 'vitest';
import { sliceTranscriptForRange, type EnrichedSentence } from '../utterances';

const partial = (text: string, startSec: number, endSec: number): EnrichedSentence => ({
  id: 'partial-1', startSec, endSec, text, wordCount: text.split(/\s+/).length,
  speakerId: 'spk-1', pauseBeforeSec: 0, pauseAfterSec: 0,
  isCompleteSentence: true, startsWithTransition: false, startsWithQuestion: false,
  endsWithQuestion: false, semanticTopicId: null, sourceCueStartIndex: 0,
  sourceCueEndIndex: 0,
  words: [
    { text: 'timed', startSec: 2, endSec: 3 },
    { text: 'inside', startSec: 3, endSec: 4 },
  ],
  sourceTokenCount: 4, timedTokenCount: 2, wordTimingCompleteness: 'partial',
});

describe('F11-07/F11-E1: final transcript slice provenance', () => {
  it('marks partial hybrid content and exposes uncertain text provenance', () => {
    const slice = sliceTranscriptForRange(
      [partial('before timed inside after', 0, 8)],
      2,
      4,
    );
    expect(slice.timingPrecision).toBe('hybrid');
    expect(slice.sliceApproximate).toBe(true);
    expect(slice.timingCoverage).toBe(slice.wordTimingCoverage);
    expect(slice.excludedOrUncertainText).toContain('before');
    expect(slice.excludedOrUncertainText).toContain('after');
  });

  it('does not label partial timing as exact word timing', () => {
    const slice = sliceTranscriptForRange(
      [partial('before timed inside after', 0, 8)],
      2,
      4,
    );
    expect(slice.timingPrecision).not.toBe('word');
    expect(slice.timingCoverage).toBeGreaterThanOrEqual(0);
    expect(slice.timingCoverage).toBeLessThan(0.95);
  });
});

void expect;
void it;
void describe;
void partial;
void sliceTranscriptForRange;
