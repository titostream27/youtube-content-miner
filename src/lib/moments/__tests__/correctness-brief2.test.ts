import { describe, it, expect } from 'vitest';
import {
  cuesToUtterances,
  sliceTranscriptForRange,
  utteranceAfter,
  type EnrichedSentence,
} from '@/lib/moments/utterances';
import { validateStartBoundary } from '@/lib/moments/start-boundary';
import type { TranscriptCue } from '@/lib/domain/types';

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

function cue(text: string, start: number, end: number, speakerId?: string | null): TranscriptCue {
  return {
    text,
    startSec: start,
    endSec: end,
    speakerId: speakerId ?? null,
  } as TranscriptCue;
}

describe('correctness brief 2 — F13/F14/F16 (RED pre-fix)', () => {
  // ── F13: word/cue-level slicing, no rough fallback ───────────────────────
  it('F13a slices at word/cue level, not whole overlapping utterances', () => {
    const utterances = [
      u(0, 10, 'alpha beta gamma', { wordCount: 3 }),
      u(10, 20, 'delta epsilon zeta', { wordCount: 3 }),
    ];
    const s = sliceTranscriptForRange(utterances, 8, 12);
    // Window 8-12 overlaps the TAIL of u0 and the HEAD of u1. A word-level
    // slice must be strictly shorter than the full concatenation.
    expect(s.text.split(' ').length).toBeLessThan(6);
  });

  it('F13b returns empty text for an empty window, not a fallback', () => {
    const s = sliceTranscriptForRange([u(100, 110, 'far away')], 0, 5);
    expect(s.text).toBe('');
    expect(s.wordCount).toBe(0);
  });

  // ── F14: speaker metadata from TranscriptCue.speakerId ───────────────────
  it('F14 cuesToUtterances propagates structured speakerId', () => {
    const cues = [
      cue('hello world', 0, 2, 'speaker_03'),
      cue('this is a longer statement', 2, 6, 'speaker_03'),
    ];
    const utterances = cuesToUtterances(cues);
    // Speaker must come from the structured field, not a missing textual tag.
    expect(utterances[0]!.speakerId).toBe('speaker_03');
  });

  it('F14 structured speakerId wins over textual SPEAKER tag', () => {
    const cues = [
      cue('[SPEAKER_00]', 0, 1, 'speaker_07'),
      cue('actual content', 1, 3, 'speaker_07'),
    ];
    const utterances = cuesToUtterances(cues);
    expect(utterances[0]!.speakerId).toBe('speaker_07');
  });

  // ── F16: referential openers anchored; casing is weak evidence ───────────
  it('F16 referential word mid-sentence is NOT a dangling opener', () => {
    const longHook = u(0, 20, 'We built this product over three years and it changed everything.', {
      isCompleteSentence: true,
    });
    const check = validateStartBoundary([longHook], 0, 20);
    expect(
      check.issues.includes('MISSING_CONTEXT') || check.issues.includes('UNRESOLVED_REFERENCE'),
    ).toBe(false);
  });

  it('F16 lowercase start without dangling pronoun is weak evidence', () => {
    const utt = u(0, 8, 'turns out the market shifted', { isCompleteSentence: true });
    const check = validateStartBoundary([utt], 0, 8);
    expect(check.issues.includes('MID_SENTENCE')).toBe(false);
  });
});

describe('Brief 2 Phase B leftovers (candidate identity / helpers / preceding context)', () => {
  // ── utteranceAfter helper (containing / before / after split) ────────────
  it('utteranceAfter returns the first utterance starting at/after target', () => {
    const utterances = [u(0, 5, 'first'), u(5, 10, 'second'), u(10, 15, 'third')];
    expect(utteranceAfter(utterances, 6)).toBe(2);
    expect(utteranceAfter(utterances, 5)).toBe(1);
    expect(utteranceAfter(utterances, 20)).toBe(-1);
  });

  // ── preceding context in start-boundary ──────────────────────────────────
  it('flags MID_SENTENCE when the preceding utterance ends mid-sentence', () => {
    // Utterance before the window ends with a trailing comma -> the window
    // opening continues that thought.
    const utterances = [
      u(0, 5, 'And the reason we pivoted,', { isCompleteSentence: false }),
      u(5, 12, 'was that the old model stopped working.', { isCompleteSentence: true }),
    ];
    const check = validateStartBoundary(utterances, 5, 12);
    expect(check.issues.includes('MID_SENTENCE')).toBe(true);
  });

  it('does NOT flag MID_SENTENCE when the preceding utterance ends cleanly', () => {
    const utterances = [
      u(0, 5, 'So we moved on completely.', { isCompleteSentence: true }),
      u(5, 12, 'The new approach was totally different.', { isCompleteSentence: true }),
    ];
    const check = validateStartBoundary(utterances, 5, 12);
    expect(check.issues.includes('MID_SENTENCE')).toBe(false);
  });
});
