// Hardening Brief v3 — Phase C gap tests (RED).
// Pins candidate-fingerprint stability (C6/#19) and final-score
// recalculation (C5/#18).
// Run: npx vitest run src/lib/moments/__tests__/hardening-v3.test.ts
import { describe, it, expect } from 'vitest';
import { candidateFingerprint } from '@/lib/moments/candidate-identity';
import { rescoreSegmentFromSlice } from '@/lib/moments/finalize-candidate';
import type { MomentSegment } from '@/lib/domain/types';

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