import { describe, expect, it } from 'vitest';
import { repairBoundary } from '@/lib/moments/boundary-repair';
import type { EnrichedSentence } from '@/lib/moments/utterances';

function utterance(
  id: string,
  startSec: number,
  endSec: number,
  text: string,
  overrides: Partial<EnrichedSentence> = {},
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
    isCompleteSentence: /[.!?…]$/.test(text),
    startsWithTransition: false,
    startsWithQuestion: false,
    endsWithQuestion: /\?$/.test(text),
    semanticTopicId: null,
    sourceCueStartIndex: 0,
    sourceCueEndIndex: 0,
    ...overrides,
  };
}

describe('repairBoundary closure recovery', () => {
  it('BR-01 never selects a complete ending wholly before roughStartSec', () => {
    // Compact reproduction of the committed g2_eval.out signature: the only
    // syntactically complete fragment lies well before the rough candidate.
    const utterances = [
      utterance('old-complete', 10, 14, 'An unrelated old thought ends here.'),
      utterance('rough-a', 100, 106, 'the current answer keeps going because'),
      utterance('rough-b', 106, 112, 'it still has no acceptable ending'),
    ];

    const result = repairBoundary(utterances, {
      roughStartSec: 100,
      roughEndSec: 112,
    });

    expect(result.boundaryStatus).toBe('rejected');
    expect(result.finalEndSec).toBeGreaterThan(result.finalStartSec);
    expect(result.finalEndSec).toBeGreaterThanOrEqual(100);
  });

  it('BR-02 reports the selected ending original index for a deep filtered window', () => {
    const utterances = [
      utterance('old-0', 0, 10, 'Old context zero.'),
      utterance('old-1', 10, 20, 'Old context one.'),
      utterance('old-2', 20, 30, 'Old context two.'),
      utterance('candidate-setup', 100, 110, 'The candidate setup is complete.'),
      utterance('candidate-end', 110, 120, 'The candidate conclusion is complete.'),
      utterance('next-topic', 121, 126, 'What should we discuss next?', { startsWithQuestion: true }),
    ];

    const result = repairBoundary(utterances, {
      roughStartSec: 100,
      roughEndSec: 120,
    });

    expect(result.boundaryStatus).toBe('refined');
    expect(result.ceilingSec).toBe(120);
    expect(result.selectedEndingOriginalIndex).toBe(4);
    expect(result.selectedEndingStartSec).toBe(110);
    expect(result.selectedEndingEndSec).toBe(120);
    expect(result.selectedEndingType).toBe('ANSWER_COMPLETE');
  });

  it('BR-03 preserves the intended candidate start when snapping the end', () => {
    const utterances = [
      utterance('opening', 100, 108, 'This opening belongs to the candidate.'),
      utterance('ending', 108, 116, 'This is the complete conclusion.'),
      utterance('next', 117, 123, 'What comes next?', { startsWithQuestion: true }),
    ];

    const result = repairBoundary(utterances, {
      roughStartSec: 100,
      roughEndSec: 118,
    });

    expect(result.boundaryStatus).toBe('repaired');
    expect(result.finalStartSec).toBe(100);
    expect(result.finalEndSec).toBe(116);
  });

  it('BR-04 extends only the end when completion is inside the extension budget', () => {
    const utterances = [
      utterance('unfinished', 100, 108, 'The answer continues because'),
      utterance('extension-ending', 108, 114, 'the final reason resolves it.'),
      utterance('after', 115, 121, 'What is the next topic?', { startsWithQuestion: true }),
    ];

    const result = repairBoundary(utterances, {
      roughStartSec: 100,
      roughEndSec: 108,
    });

    expect(result.boundaryStatus).toBe('repaired');
    expect(result.finalStartSec).toBe(100);
    expect(result.finalEndSec).toBe(114);
    expect(result.needsRefinementRetry).toBe(true);
  });

  it('BR-05 rejects when no acceptable ending exists without synthesizing duration', () => {
    const utterances = [
      utterance('fragment-a', 100, 106, 'so basically'),
      utterance('fragment-b', 106, 112, 'and then it was like'),
    ];

    const result = repairBoundary(utterances, {
      roughStartSec: 100,
      roughEndSec: 112,
    });

    expect(result.boundaryStatus).toBe('rejected');
    expect(result.finalStartSec).toBe(100);
    expect(result.finalEndSec).toBe(112);
    expect(result.repairReason).toMatch(/no complete idea/i);
  });

  it('BR-06 treats preferEndBeforeSec as an authoritative next-topic ceiling', () => {
    const utterances = [
      utterance('safe-incomplete', 100, 108, 'The safe portion continues because'),
      utterance('next-topic-ending', 108, 114, 'the next topic has a complete sentence.'),
    ];

    const result = repairBoundary(
      utterances,
      { roughStartSec: 100, roughEndSec: 116 },
      108,
    );

    expect(result.boundaryStatus).toBe('rejected');
    expect(result.finalEndSec).toBeLessThanOrEqual(116);
    expect(result.repairReason).toMatch(/no complete idea/i);
  });

  it('limits extension to a supplied guard that falls after the rough end', () => {
    const utterances = [
      utterance('unfinished', 100, 108, 'The answer continues because'),
      utterance('past-guard', 108, 115, 'the next topic ends completely.'),
    ];

    const result = repairBoundary(
      utterances,
      { roughStartSec: 100, roughEndSec: 108 },
      112,
    );

    expect(result.boundaryStatus).toBe('rejected');
    expect(result.repairReason).toMatch(/no complete idea/i);
  });

  it('does not turn a distant preferred ceiling into an unbudgeted extension', () => {
    const utterances = [
      utterance('unfinished', 100, 108, 'The answer continues because'),
      utterance('far-ending', 140, 150, 'A distant complete thought.'),
    ];

    const result = repairBoundary(
      utterances,
      { roughStartSec: 100, roughEndSec: 108 },
      200,
    );

    expect(result.boundaryStatus).toBe('rejected');
    expect(result.repairReason).toMatch(/no complete idea/i);
  });

  it('BR-07 does not collapse a 30-60 second candidate to one ASR ending fragment', () => {
    const utterances = [
      utterance('asr-0', 100, 106, 'short fragment one'),
      utterance('asr-1', 106, 113, 'short fragment two'),
      utterance('asr-2', 113, 121, 'short fragment three'),
      utterance('asr-3', 121, 130, 'short fragment four'),
      utterance('asr-end', 130, 140, 'The complete answer ends here.'),
    ];

    const result = repairBoundary(utterances, {
      roughStartSec: 100,
      roughEndSec: 141,
    });

    expect(result.boundaryStatus).toBe('repaired');
    expect(result.finalStartSec).toBe(100);
    expect(result.finalEndSec - result.finalStartSec).toBe(40);
  });

  it('BR-08 allows an utterance overlapping roughStartSec but excludes one wholly before it', () => {
    const utterances = [
      utterance('wholly-before', 80, 90, 'An old complete thought.'),
      utterance('overlapping', 95, 106, 'The overlapping thought is complete.'),
    ];

    const result = repairBoundary(utterances, {
      roughStartSec: 100,
      roughEndSec: 108,
    });

    expect(result.boundaryStatus).toBe('repaired');
    expect(result.selectedEndingOriginalIndex).toBe(1);
    expect(result.finalStartSec).toBe(100);
    expect(result.finalEndSec).toBe(106);
  });

  it('BR-09 rejects an invalid rough range before ending selection', () => {
    const utterances = [utterance('complete', 100, 110, 'A complete sentence.')];

    const result = repairBoundary(utterances, {
      roughStartSec: 110,
      roughEndSec: 100,
    });

    expect(result.boundaryStatus).toBe('rejected');
    expect(result.repairReason).toMatch(/invalid rough range/i);
  });

  it('BR-10 rejects non-finite rough timestamps before selection', () => {
    const utterances = [utterance('complete', 100, 110, 'A complete sentence.')];

    const result = repairBoundary(utterances, {
      roughStartSec: Number.NaN,
      roughEndSec: 110,
    });

    expect(result.boundaryStatus).toBe('rejected');
    expect(result.repairReason).toMatch(/non-finite/i);
  });

  it('rejects an epsilon-jitter anchor that would emit end at or before start', () => {
    const utterances = [
      utterance('jitter-before', 95, 99.98, 'A complete but pre-candidate thought.'),
      utterance('current-incomplete', 100, 110, 'the current answer continues because'),
    ];

    const result = repairBoundary(utterances, {
      roughStartSec: 100,
      roughEndSec: 110,
    });

    expect(result.boundaryStatus).toBe('rejected');
    expect(result.repairReason).toMatch(/invalid repaired range/i);
  });

  it('BR-11 handles transcript start and end edges without out-of-bounds context', () => {
    const transcriptStart = [utterance('only-start', 0, 8, 'A complete opening thought.')];
    const startResult = repairBoundary(transcriptStart, {
      roughStartSec: 0,
      roughEndSec: 8,
    });

    const transcriptEnd = [
      utterance('setup', 20, 28, 'The setup is clear.'),
      utterance('only-end', 28, 36, 'The final thought is complete.'),
    ];
    const endResult = repairBoundary(transcriptEnd, {
      roughStartSec: 20,
      roughEndSec: 36,
    });

    expect(startResult.boundaryStatus).toBe('refined');
    expect(startResult.selectedEndingOriginalIndex).toBe(0);
    expect(endResult.boundaryStatus).toBe('refined');
    expect(endResult.selectedEndingOriginalIndex).toBe(1);
  });

  it('BR-12 returns structurally identical results for identical inputs', () => {
    const utterances = [
      utterance('setup', 40, 50, 'The setup belongs to this candidate.'),
      utterance('ending', 50, 60, 'The conclusion is complete.'),
    ];
    const candidate = { roughStartSec: 40, roughEndSec: 61 };

    const first = repairBoundary(utterances, candidate);
    const second = repairBoundary(utterances, candidate);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('preserves finite ordered ranges across deterministic generated windows', () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const utterances: EnrichedSentence[] = [];
      let cursor = seed % 5;
      for (let i = 0; i < 24; i += 1) {
        const duration = 2 + ((seed * 7 + i * 3) % 10);
        const gap = ((seed + i) % 3) * 0.1;
        const start = cursor + gap;
        const end = start + duration;
        const complete = (seed + i) % 4 === 0;
        utterances.push(
          utterance(
            `generated-${seed}-${i}`,
            start,
            end,
            complete ? `Generated thought ${i} is complete.` : `generated fragment ${i}`,
          ),
        );
        cursor = end;
      }

      const startIndex = (seed * 5) % 18;
      const endIndex = Math.min(23, startIndex + 3 + (seed % 4));
      const roughStartSec = utterances[startIndex]!.startSec;
      const roughEndSec = utterances[endIndex]!.endSec;
      const result = repairBoundary(utterances, { roughStartSec, roughEndSec });

      if (result.boundaryStatus !== 'rejected') {
        expect(Number.isFinite(result.finalStartSec)).toBe(true);
        expect(Number.isFinite(result.finalEndSec)).toBe(true);
        expect(result.finalStartSec).toBeGreaterThanOrEqual(0);
        expect(result.finalEndSec).toBeGreaterThan(result.finalStartSec);
        expect(result.finalEndSec).toBeGreaterThanOrEqual(roughStartSec - 0.05);
        expect(result.finalEndSec).toBeLessThanOrEqual(
          utterances[utterances.length - 1]!.endSec + 0.05,
        );
      }
    }
  });
});
