/**
 * Brief v10 C08 — test(miner): expose partial word-timing text loss.
 *
 * Findings:
 * - V10-M02: an utterance is treated as fully timed when words.length > 0.
 *   If a 10-word utterance only has timestamps for 3 words, the other 7 can
 *   disappear from hybrid text and do NOT contribute to the uncovered-speech
 *   denominator (overstated coverage).
 *
 * Tests (RED on v10 baseline, GREEN after C9):
 *   V10-MT10  10-word utterance with 3 timed words -> final text still
 *            contains all intended in-window speech; precision hybrid.
 *   V10-MT11  full timing -> exact word slice and coverage ~1.
 *   V10-MT12  zero timing -> no text loss; precision utterance/cue.
 *   V10-MT13  A(full) -> B(partial) -> C(none) remains chronological, no dup.
 *   V10-MT14  repeated/duplicate tokens do not cause accidental omission.
 */
import { describe, it, expect } from 'vitest';
import type { EnrichedSentence } from '../utterances';
import { sliceTranscriptForRange } from '../utterances';

function utt(id: string, startSec: number, endSec: number, text: string,
             words?: { text: string; startSec: number; endSec: number }[]): EnrichedSentence {
  return {
    id, startSec, endSec, text,
    wordCount: text.trim().split(/\s+/).filter(Boolean).length,
    speakerId: null, pauseBeforeSec: 0, pauseAfterSec: 0,
    isCompleteSentence: true, startsWithTransition: false,
    startsWithQuestion: false, endsWithQuestion: false,
    semanticTopicId: null, sourceCueStartIndex: 0, sourceCueEndIndex: 1,
    ...(words ? { words } : {}),
  } as unknown as EnrichedSentence;
}

describe('V10-M02: partial word timing never loses speech', () => {
  it('MT10 — 3/10 timed words: text still contains all intended speech; precision hybrid', () => {
    // 10-word utterance, only 3 words have timing.
    const u = utt('u1', 0, 10, 'one two three four five six seven eight nine ten', [
      { text: 'one', startSec: 0, endSec: 1 },
      { text: 'two', startSec: 1, endSec: 2 },
      { text: 'three', startSec: 2, endSec: 3 },
    ]);
    const slice = sliceTranscriptForRange([u], 0, 10);
    // All ten words must be present (partial timing must not drop untimed words).
    for (const w of ['one','two','three','four','five','six','seven','eight','nine','ten']) {
      expect(slice.text.toLowerCase().split(/\s+/)).toContain(w);
    }
    // Precision must be hybrid (not word), because timing is only partial.
    expect(slice.timingPrecision).toBe('hybrid');
  });

  it('MT11 — full timing: exact word slice and coverage ~1', () => {
    const words = ['one','two','three'].map((w, i) => ({ text: w, startSec: i, endSec: i + 1 }));
    const u = utt('u1', 0, 3, 'one two three', words);
    const slice = sliceTranscriptForRange([u], 0, 3);
    expect(slice.timingPrecision).toBe('word');
    expect(slice.text.trim()).toBe('one two three');
    expect(slice.wordTimingCoverage).toBeGreaterThanOrEqual(0.95);
  });

  it('MT12 — zero timing: no text loss; precision utterance', () => {
    const u = utt('u1', 0, 3, 'one two three four', undefined);
    const slice = sliceTranscriptForRange([u], 0, 3);
    expect(slice.timingPrecision).toBe('utterance');
    for (const w of ['one','two','three','four']) {
      expect(slice.text.split(/\s+/)).toContain(w);
    }
  });

  it('MT13 — A(full) -> B(partial) -> C(none) stays chronological, no duplication', () => {
    const a = utt('a', 0, 2, 'alpha beta', [
      { text: 'alpha', startSec: 0, endSec: 1 },
      { text: 'beta', startSec: 1, endSec: 2 },
    ]);
    const b = utt('b', 2, 5, 'charlie delta', [
      { text: 'charlie', startSec: 2, endSec: 3 }, // delta untimed
    ]);
    const c = utt('c', 5, 7, 'echo foxtrot', undefined);
    const slice = sliceTranscriptForRange([a, b, c], 0, 7);
    const words = slice.text.toLowerCase().split(/\s+/).filter(Boolean);
    const idxA = words.indexOf('alpha');
    const idxC = words.indexOf('charlie');
    const idxE = words.indexOf('echo');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxE);
    // No duplicate words (we don't double-count timed + source text).
    expect(new Set(words).size).toBe(words.length);
  });

  it('MT14 — repeated tokens do not cause accidental omission', () => {
    const u = utt('u1', 0, 3, 'well well well good', undefined);
    const slice = sliceTranscriptForRange([u], 0, 3);
    const words = slice.text.toLowerCase().split(/\s+/).filter(Boolean);
    expect(words.filter((w) => w === 'well').length).toBe(3);
    expect(words).toContain('good');
  });
});