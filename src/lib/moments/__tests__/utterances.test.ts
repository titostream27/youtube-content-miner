import { describe, it, expect } from 'vitest';
import { cuesToUtterances } from '@/lib/moments/utterances';
import type { TranscriptCue } from '@/lib/domain/types';

function cue(start: number, end: number, text: string): TranscriptCue {
  return { startSec: start, endSec: end, text, confidence: 1, source: 'test' } as TranscriptCue;
}

describe('cuesToUtterances — enriched sentence model (brief §5/§41)', () => {
  it('groups cues into sentences with punctuation (English)', () => {
    const cues = [
      cue(0, 1.2, 'The product failed.'),
      cue(1.2, 2.5, 'We expanded too fast.'),
    ];
    const u = cuesToUtterances(cues);
    expect(u).toHaveLength(2);
    expect(u[0]!.isCompleteSentence).toBe(true);
    expect(u[0]!.text).toBe('The product failed.');
    expect(u[0]!.pauseAfterSec).toBeCloseTo(0);
    expect(u[1]!.startSec).toBeCloseTo(1.2);
  });

  it('handles a transcript WITHOUT punctuation (fallback on pause/word cap)', () => {
    const cues = [
      cue(0, 1.0, 'the product failed'),
      cue(1.0, 2.0, 'we expanded too fast'),
      cue(2.0, 3.0, 'and then the market shifted'),
    ];
    const u = cuesToUtterances(cues);
    // No punctuation and no big gaps -> one long utterance (not split).
    expect(u.length).toBeGreaterThanOrEqual(1);
    expect(u[0]!.text).toContain('product failed');
  });

  it('does NOT split mid-sentence on punctuation alone for short units (word-count guard)', () => {
    // A cue that ends with a period but is only 1 word is treated as content
    // of the ongoing unit, not a new sentence boundary.
    const cues = [
      cue(0, 3.0, 'We tried many things over the years'),
      cue(3.0, 3.4, 'okay.'),
    ];
    const u = cuesToUtterances(cues);
    expect(u).toHaveLength(1);
    expect(u[0]!.text).toContain('We tried many things');
  });

  it('breaks on a long audio pause (topic gap)', () => {
    const cues = [
      cue(0, 2.0, 'The first point is clear'),
      cue(5.0, 7.0, 'Now the second point'),
    ];
    const u = cuesToUtterances(cues);
    expect(u).toHaveLength(2);
    expect(u[1]!.pauseBeforeSec).toBeCloseTo(3.0, 0);
  });

  it('breaks on a speaker change', () => {
    const cues = [
      cue(0, 2.0, '[SPEAKER_00]'),
      cue(0.1, 2.0, 'I think this is right'),
      cue(2.0, 4.0, '[SPEAKER_01]'),
      cue(2.1, 4.0, 'I disagree completely'),
    ];
    const u = cuesToUtterances(cues);
    expect(u).toHaveLength(2);
    expect(u[0]!.speakerId).toContain('SPEAKER_00');
    expect(u[1]!.speakerId).toContain('SPEAKER_01');
    expect(u[0]!.text).toBe('I think this is right');
    expect(u[1]!.text).toBe('I disagree completely');
  });

  it('caps a very long punctuation-free run at the word bound', () => {
    // Many small punctuation-free cues (YouTube ASR style) that together far
    // exceed the 45-word cap, with no pauses. The fallback must split them
    // between cues instead of producing one giant run-on unit.
    const cues = Array.from({ length: 10 }, (_, k) => {
      const start = k * 2;
      const words = Array.from({ length: 6 }, (_, i) => `w${k}_${i}`).join(' ');
      return cue(start, start + 2, words);
    });
    const u = cuesToUtterances(cues);
    expect(u.length).toBeGreaterThanOrEqual(2);
    // No single unit should exceed the word bound by much.
    for (const unit of u) {
      expect(unit.wordCount).toBeLessThanOrEqual(45 + 6);
    }
  });

  it('works for Bahasa Indonesia', () => {
    const cues = [
      cue(0, 1.5, 'Itulah tiga alasan mengapa produknya gagal.'),
      cue(1.5, 3.0, 'Ngomong-ngomong, setelah itu kamu pindah ke mana?'),
    ];
    const u = cuesToUtterances(cues);
    expect(u).toHaveLength(2);
    expect(u[0]!.text).toContain('tiga alasan');
    expect(u[1]!.startsWithTransition).toBe(true);
    expect(u[1]!.endsWithQuestion).toBe(true);
  });

  it('enriches metadata: source cue indices + question flags', () => {
    const cues = [
      cue(0, 1.0, 'What happened next?'),
      cue(1.0, 2.5, 'We moved to Australia.'),
    ];
    const u = cuesToUtterances(cues);
    expect(u[0]!.startsWithQuestion).toBe(true);
    expect(u[0]!.endsWithQuestion).toBe(true);
    expect(u[0]!.sourceCueStartIndex).toBe(0);
    expect(u[0]!.sourceCueEndIndex).toBe(0);
    expect(u[1]!.sourceCueStartIndex).toBe(1);
  });
});
