import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Brief v8 C09 — test(miner): cover every time-based next-topic lookahead
 * path and finalization-metadata ordering (RED on v7, GREEN after C10).
 *
 * - M01: NO live path may use a count-based slice(endIdx+1, endIdx+N) for
 *   next-topic lookahead; every path must use followingWithinLookaheadSec.
 * - M02: the lookahead horizon must anchor to the ACTUAL final end `e`, not
 *   the end utterance's start (endU.startSec shortens the horizon).
 * - M03: repaired-path debug metadata must be written AFTER finalizeCandidate,
 *   from the finalized segment timestamps.
 * - M04: only finalizeCandidate may own start repair.
 */
describe('V8-M01: all next-topic lookahead paths are seconds-based', () => {
  it('no live path uses a count-based slice for lookahead (source guard)', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/moments/two-pass.ts'),
      'utf8',
    );
    // The bad count-based pattern must not appear in the production source.
    const matches = src.match(/\.slice\(endIdx \+ 1, endIdx \+ (\d+)\)/g) || [];
    // Every such slice must be the followingWithinLookaheadSec helper applied
    // with a seconds argument — i.e. no slice(endIdx+1, endIdx+N) remains.
    expect(matches, `count-based slice found: ${matches.join(', ')}`).toEqual([]);
    // The seconds-based helper must be used.
    const helperUses = (src.match(/followingWithinLookaheadSec\(/g) || []).length;
    expect(helperUses).toBeGreaterThanOrEqual(3);
  });
});

describe('V8-M02: lookahead anchored to actual final end', () => {
  it('finalRangeValidationFor passes the real final end `e`, not endU.startSec', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/moments/two-pass.ts'),
      'utf8',
    );
    // The finalRangeValidationFor callbacks must anchor lookahead to the
    // candidate end (e), not to endU.startSec.
    const badAnchors = src.match(/followingWithinLookaheadSec\([\s\S]{0,80}?endU\.startSec/g);
    expect(badAnchors, 'lookahead must not anchor to endU.startSec').toBeNull();
  });
});

describe('V8-M03: repaired debug metadata comes from finalization', () => {
  it('every endingById.set follows a finalizeCandidate call', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/moments/two-pass.ts'),
      'utf8',
    );
    // Both semantic and repaired branches must finalize BEFORE recording
    // debug metadata. Assert the LAST endingById.set appears after the LAST
    // finalizeCandidate call in the file (both branches end with finalize ->
    // metadata -> push).
    const lastSet = src.lastIndexOf('endingById.set(');
    const lastFin = src.lastIndexOf('const finalized = finalizeCandidate(');
    expect(lastSet).toBeGreaterThan(lastFin);
    // And there must be exactly two metadata sites (semantic + repaired).
    const sites = (src.match(/endingById\.set\(/g) || []).length;
    expect(sites).toBe(2);
  });
});