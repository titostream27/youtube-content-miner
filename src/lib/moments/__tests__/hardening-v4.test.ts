// Brief v4 Phase B/C miner gap tests (RED).
// Pins CONFIRMED findings before the fixes:
// - F11 paragraph pause must FLUSH BEFORE adding the current cue, so the cue
//   after the pause starts a new utterance (not merge into the previous one).
// - F12 question/transition opener detection must anchor to the START of the
//   utterance — mid-sentence 'why'/'anyway' must not set startsWith*.
// - F13 word-level slicing must clip FIRST and LAST words to the window.
// Run: npx vitest run src/lib/moments/__tests__/hardening-v4.test.ts
import { describe, it, expect } from 'vitest';
import {
  cuesToUtterances,
  sliceTranscriptForRange,
  type EnrichedSentence,
} from '@/lib/moments/utterances';
import type { TranscriptCue } from '@/lib/domain/types';

function cue(start: number, end: number, text: string, extra: Partial<TranscriptCue> = {}): TranscriptCue {
  return {
    startSec: start,
    endSec: end,
    text,
    speakerId: null,
    words: undefined,
    ...extra,
  };
}

describe('F11 paragraph pause splits BEFORE adding the cue', () => {
  it('a cue after a long pause starts a NEW utterance', () => {
    // Cue1 has NO terminal punctuation and ends at 5; cue2 starts at 6
    // (1.0s gap > 0.75s paragraph threshold). Without the pause rule the
    // second cue merges into the first; with it they must split BEFORE
    // adding cue2 so cue2 starts a fresh utterance.
    const cues = [
      cue(0, 5, 'This is the first topic'),
      cue(6, 9, 'now a brand new topic entirely'),
    ];
    const utts = cuesToUtterances(cues);
    expect(utts.length).toBe(2);
    expect(utts[0]!.text).toContain('first topic');
    expect(utts[1]!.text).toContain('brand new topic');
  });
});

describe('F12 question/transition opener anchored to utterance start', () => {
  it('mid-sentence why does NOT set startsWithQuestion', () => {
    const cues = [cue(0, 5, 'The reason we did it is why we grew so fast.')];
    const utts = cuesToUtterances(cues);
    expect(utts[0]!.startsWithQuestion).toBe(false);
  });

  it('mid-sentence transition phrase does NOT set startsWithTransition', () => {
    const cues = [cue(0, 5, 'People kept asking me anyway, so I explained.')];
    const utts = cuesToUtterances(cues);
    expect(utts[0]!.startsWithTransition).toBe(false);
  });

  it('utterance STARTING with a question word DOES set startsWithQuestion', () => {
    const cues = [cue(0, 5, 'Why did we pivot so fast?')];
    const utts = cuesToUtterances(cues);
    expect(utts[0]!.startsWithQuestion).toBe(true);
  });
});

describe('F13 word-level slicing clips first/last words to the window', () => {
  it('words inside the range are included; boundary words are clipped', () => {
    const utts: EnrichedSentence[] = [
      {
        id: 'u1', startSec: 0, endSec: 10, text: 'one two three four five',
        wordCount: 5, speakerId: null, pauseBeforeSec: 0, pauseAfterSec: 0,
        isCompleteSentence: true, startsWithTransition: false,
        startsWithQuestion: false, endsWithQuestion: false,
        semanticTopicId: null, sourceCueStartIndex: 0,
        words: [
          { startSec: 0, endSec: 1, text: 'one' },
          { startSec: 1, endSec: 2, text: 'two' },
          { startSec: 2, endSec: 3, text: 'three' },
          { startSec: 3, endSec: 4, text: 'four' },
          { startSec: 4, endSec: 5, text: 'five' },
        ],
      } as unknown as EnrichedSentence,
    ];
    const slice = sliceTranscriptForRange(utts, 1.5, 4.5);
    // Words strictly inside [1.5, 4.5): two (1-2), three (2-3), four (3-4).
    expect(slice.text).toBe('two three four');
    expect(slice.wordCount).toBe(3);
    expect(slice.timingPrecision).toBe('word');
    expect(slice.sliceApproximate).toBe(false);
  });
});
