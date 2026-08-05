import { describe, it, expect } from 'vitest';
import {
  sliceTranscriptForRange,
  type EnrichedSentence,
} from '@/lib/moments/utterances';

function u(
  id: string,
  startSec: number,
  endSec: number,
  text: string,
  speakerId: string | null = null,
): EnrichedSentence {
  return {
    id,
    startSec,
    endSec,
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    speakerId,
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

describe('sliceTranscriptForRange (Phase 2 intelligence correctness)', () => {
  const utterances = [
    u('s1', 0.0, 2.0, 'Hello everyone welcome back', 'SPEAKER_00'),
    u('s2', 2.2, 4.0, 'Today we talk about growth', 'SPEAKER_00'),
    u('s3', 4.2, 6.0, 'So what went wrong exactly', 'SPEAKER_01'),
    u('s4', 6.2, 8.5, 'We scaled too fast and broke the model', 'SPEAKER_00'),
    u('s5', 8.8, 10.0, 'That is the core insight', 'SPEAKER_01'),
  ];

  it('returns only utterances overlapping the range', () => {
    const s = sliceTranscriptForRange(utterances, 4.2, 8.5);
    expect(s.text).toBe('So what went wrong exactly We scaled too fast and broke the model');
    expect(s.wordCount).toBe(13);
  });

  it('computes wordsPerSecond from the actual duration', () => {
    const s = sliceTranscriptForRange(utterances, 4.2, 8.5);
    expect(s.wordsPerSecond).toBeCloseTo(13 / 4.3, 1);
  });

  it('counts speaker turns inside the window', () => {
    // s3 (SPEAKER_01) then s4 (SPEAKER_00) = 1 turn change.
    const s = sliceTranscriptForRange(utterances, 4.2, 8.5);
    expect(s.speakerTurns).toBe(1);
  });

  it('returns empty text when nothing overlaps', () => {
    const s = sliceTranscriptForRange(utterances, 100, 110);
    expect(s.text).toBe('');
    expect(s.wordCount).toBe(0);
    expect(s.wordsPerSecond).toBe(0);
  });

  it('does not crash on zero-length or inverted ranges', () => {
    const s = sliceTranscriptForRange(utterances, 5.0, 5.0);
    expect(s.wordsPerSecond).toBeGreaterThanOrEqual(0);
  });
});
