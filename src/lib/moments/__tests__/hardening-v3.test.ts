// Hardening Brief v3 — Phase C gap tests (RED).
// Pins candidate-fingerprint stability (C6/#19) and final-score
// recalculation (C5/#18).
// Run: npx vitest run src/lib/moments/__tests__/hardening-v3.test.ts
import { describe, it, expect } from 'vitest';
import { candidateFingerprint } from '@/lib/moments/candidate-identity';
import { rescoreSegmentFromSlice } from '@/lib/moments/finalize-candidate';
import { validateStartBoundary } from '@/lib/moments/start-boundary';
import { sliceTranscriptForRange } from '@/lib/moments/utterances';
import type { EnrichedSentence } from '@/lib/moments/utterances';
import type { MomentSegment } from '@/lib/domain/types';

function u(start: number, end: number, text: string, isCompleteSentence = true): EnrichedSentence {
  return {
    id: `u-${start}`,
    startSec: start,
    endSec: end,
    text,
    wordCount: text.trim().split(/\s+/).length,
    wordsPerSecond: 1,
    speakerId: null,
    speaker: null,
    isCompleteSentence,
    pauseBeforeSec: 0,
    pauseAfterSec: 0,
  } as unknown as EnrichedSentence;
}

describe('C2 pronoun resolution uses PRECEDING context (#20)', () => {
  it('a window starting with a pronoun whose antecedent is BEFORE the window is NOT unresolved', () => {
    // "he" in the window refers to the guest named before the window.
    const ctx = [
      u(0, 5, 'Our guest today is Dr. Rivera.'),
      u(5, 8, 'He is a world-class cardiologist.'),
    ];
    const check = validateStartBoundary(ctx, 5, 8);
    // Dr. Rivera (preceding noun context) resolves "He" — must NOT flag
    // UNRESOLVED_REFERENCE.
    expect(check.issues.includes('UNRESOLVED_REFERENCE')).toBe(false);
    expect(check.startComplete).toBe(true);
  });

  it('a pronoun with NO antecedent anywhere (before or inside) is unresolved', () => {
    const ctx = [
      u(0, 5, 'We open with a quick intro to the topic.'),
      u(5, 8, 'He will explain the details later.'),
    ];
    const check = validateStartBoundary(ctx, 5, 8);
    expect(check.issues.includes('UNRESOLVED_REFERENCE')).toBe(true);
  });
});

describe('C4 transcript slicing hierarchy (#17)', () => {
  it('sliceTranscriptForRange marks cue-level precision when words are absent', () => {
    const utt = [u(0, 10, 'a complete thought worth clipping.')];
    const slice = sliceTranscriptForRange(utt, 0, 10);
    // New fields: timing precision + approximate flag must exist and be
    // honest — cue-level here because no word timing is provided.
    expect(slice).toHaveProperty('timingPrecision');
    expect(slice.timingPrecision).toBe('cue');
  });
});

describe('C6 stable candidate identity (#19)', () => {
  it('fingerprint is content/window based, not index based', () => {
    // Same video, same rough window + same first/last phrase -> same id
    // even when segment indexes differ.
    const a = candidateFingerprint('vid-1', 12.3, 45.6, 'first phrase here', 'final phrase here');
    const b = candidateFingerprint('vid-1', 12.3, 45.6, 'first phrase here', 'final phrase here');
    expect(a).toBe(b);
    // Different window -> different fingerprint.
    const c = candidateFingerprint('vid-1', 13.0, 45.6, 'first phrase here', 'final phrase here');
    expect(c).not.toBe(a);
    // Same window but different video -> different fingerprint.
    const d = candidateFingerprint('vid-2', 12.3, 45.6, 'first phrase here', 'final phrase here');
    expect(d).not.toBe(a);
    expect(a).toMatch(/^[a-f0-9]{16,64}$/);
  });
});

describe('C5 final rescoring (#18)', () => {
  it('salience and derived scores are recomputed from the final slice', () => {
    const rough: MomentSegment = {
      index: 3,
      startSec: 10,
      endSec: 20,
      durationSec: 10,
      text: 'rough window text that is not the final slice',
      wordCount: 6,
      wordsPerSecond: 0.6,
      salience: 0.95, // inherited rough value
      candidateId: '',
      generationRunId: 'g',
      revision: 1,
    };
    const finalSlice = {
      text: 'the real final transcript words that matter',
      wordCount: 7,
      wordsPerSecond: 0.7,
      speakerTurns: 2,
    };
    const updated = rescoreSegmentFromSlice(rough, finalSlice);
    // Salience must be recomputed from the final slice, not inherited.
    expect(updated.salience).not.toBe(0.95);
    expect(updated.text).toBe(finalSlice.text);
    expect(updated.wordCount).toBe(7);
    expect(updated.wordsPerSecond).toBeCloseTo(0.7, 2);
  });
});