"""Hardening Sprint Phase C — miner boundary correctness (RED).

Pins the contracts the brief requires before the fix:

  P0.3/T09   start-boundary validation is a REPAIR/REJECT gate:
             - a start with hard failures (MID_SENTENCE, MISSING_CONTEXT,
               UNRESOLVED_REFERENCE) is NOT accepted as a soft cap;
             - startBoundaryNeedsRejection() returns true for those issues and
               false for LATE_HOOK (which stays a scoring penalty);
             - expandStartToComplete() pulls the window BACK to a complete
               prior utterance so the repair can clear the gate.
  P1.M4/T10  cuesToUtterances splits on paragraph-length pauses.
  P1.M6      containing / before / after timestamp helpers stay correct.

Run: npx vitest run src/lib/moments/__tests__/hardening-phase-c.test.ts
"""
import { describe, it, expect } from 'vitest';
import {
  cuesToUtterances,
  utteranceAfter,
  utteranceAtOrBefore,
  type EnrichedSentence,
  type TranscriptCue,
} from '@/lib/moments/utterances';
import {
  startBoundaryHard,  // via a gate helper below
} from '@/lib/moments/start-boundary';
import {
  expandStartBackToComplete,
  startBoundaryNeedsReject,
} from '@/lib/moments/start-gate';
import { validateStartBoundary } from '@/lib/moments/start-boundary';

// ── P1.M6: timestamp helpers ─────────────────────────────────────────────
describe('P1.M6 timestamp helpers', () => {
  const ut: EnrichedSentence[] = [
    { startSec: 0, endSec: 5, text: 'a', wordCount: 1 } as never as EnrichedSentence,
    { startSec: 5, endSec: 10, text: 'b', wordCount: 1 } as never as EnrichedSentence,
    { startSec: 10, endSec: 15, text: 'c', wordCount: 1 } as never as EnrichedSentence,
  ];
  it('utteranceAfter returns the first utterance starting at/after target', () => {
    expect(utteranceAfter(ut, 6)).toBe(2);
    expect(utteranceAfter(ut, 5)).toBe(1);
  });
  it('utteranceAtOrBefore prefers the containing utterance for an interior time', () => {
    expect(utteranceAtOrBefore(ut, 7)).toBe(1);
  });
});

// ── P1.M4 / T10 — paragraph pause splits utterances ──────────────────────
describe('P1.M4 paragraph pause split (T10)', () => {
  it('a <2.5s but >=0.75s pause after a complete thought starts a new utterance', () => {
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
    const hard = startBoundaryNeedsReject(['MID_SENTENCE']);
    expect(hard).toBe(true);
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
      { startSec: 0, endSec: 4, text: 'Right, we last talked about hiring.', wordCount: 6 } as never as EnrichedSentence,
      { startSec: 4, endSec: 8, text: 'now the focus is growth.', wordCount: 5 } as never as EnrichedSentence,
    ];
    const repaired = expandStartBackToComplete(ctx, 4);
    expect(repaired).toBe(0);
  });
});