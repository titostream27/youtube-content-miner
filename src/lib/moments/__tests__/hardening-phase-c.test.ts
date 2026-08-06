// Hardening Sprint Phase C - miner boundary correctness (RED).
// Pins P0.3/P1.M4/P1.M6/T09/T10 before the fix.
// Run: npx vitest run src/lib/moments/__tests__/hardening-phase-c.test.ts
import { describe, it, expect } from 'vitest';
import {
  cuesToUtterances,
  utteranceAfter,
  utteranceAtOrBefore,
  type EnrichedSentence,
} from '@/lib/moments/utterances';
import type { TranscriptCue } from '@/lib/domain/types';
import { validateStartBoundary } from '@/lib/moments/start-boundary';
import {
  expandStartBackToComplete,
  startBoundaryNeedsReject,
} from '@/lib/moments/start-gate';

// ── P1.M6: timestamp helpers ─────────────────────────────────────────────
describe('P1.M6 timestamp helpers', () => {
  const ut: EnrichedSentence[] = [
    { startSec: 0, endSec: 5, text: 'a', wordCount: 1, isCompleteSentence: true } as EnrichedSentence,
    { startSec: 5, endSec: 10, text: 'b', wordCount: 1, isCompleteSentence: true } as EnrichedSentence,
    { startSec: 10, endSec: 15, text: 'c', wordCount: 1, isCompleteSentence: true } as EnrichedSentence,
  ];
  it('utteranceAfter returns the first utterance starting at/after target', () => {
    expect(utteranceAfter(ut, 6)).toBe(2);
    expect(utteranceAfter(ut, 5)).toBe(1);
  });
  it('utteranceAtOrBefore prefers the containing utterance for an interior time', () => {
    expect(utteranceAtOrBefore(ut, 7)).toBe(1);
  });
});

// ── P1.M3 / T10 — paragraph pause splits utterances ──────────────────────
describe('P1.M3 paragraph pause split (T10)', () => {
  it('a >=0.75s paragraph pause after a complete thought starts a new utterance', () => {
    const cues: TranscriptCue[] = [
      { startSec: 0, endSec: 4.0, text: 'the market is shifting now.' },
      { startSec: 5.0, endSec: 8.0, text: 'So let me explain the new strategy.' },
    ];
    const ur = cuesToUtterances(cues);
    const second = ur.find((x) => x.startSec >= 4.9 && x.text.includes('explain'));
    expect(second).toBeDefined();
    expect(ur.length).toBeGreaterThanOrEqual(2);
  });
});

// ── P0.3 — start gate: reject vs soft penalty ────────────────────────────
describe('P0.3 start-boundary gate', () => {
  it('MID_SENTENCE is a hard rejection, not a soft cap', () => {
    expect(startBoundaryNeedsReject(['MID_SENTENCE'])).toBe(true);
  });
  it('MISSING_CONTEXT is a hard rejection', () => {
    expect(startBoundaryNeedsReject(['MISSING_CONTEXT'])).toBe(true);
  });
  it('UNRESOLVED_REFERENCE is a hard rejection', () => {
    expect(startBoundaryNeedsReject(['UNRESOLVED_REFERENCE'])).toBe(true);
  });
  it('LATE_HOOK stays a scoring penalty (not a gate)', () => {
    expect(startBoundaryNeedsReject(['LATE_HOOK'])).toBe(false);
  });

  it('expandStartBackToComplete pulls start back to a complete prior utterance', () => {
    const ctx: EnrichedSentence[] = [
      { startSec: 0, endSec: 4, text: 'Right, we last talked about hiring.', wordCount: 6, isCompleteSentence: true } as EnrichedSentence,
      { startSec: 4, endSec: 8, text: 'now the focus is growth.', wordCount: 5, isCompleteSentence: false } as EnrichedSentence,
    ];
    const repaired = expandStartBackToComplete(ctx, 4);
    expect(repaired).toBe(0);
  });

  it('validateStartBoundary reports a mid-sentence issue for a mid-utterance start', () => {
    const ctx: EnrichedSentence[] = [
      { startSec: 0, endSec: 6, text: 'we talked about hiring and now the focus.', wordCount: 8, isCompleteSentence: true } as EnrichedSentence,
    ];
    const check = validateStartBoundary(ctx, 2, 6);
    expect(check.startComplete).toBe(false);
  });
});