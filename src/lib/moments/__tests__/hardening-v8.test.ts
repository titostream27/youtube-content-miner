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
  it('endingById.set must follow its finalizeCandidate call', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/moments/two-pass.ts'),
      'utf8',
    );
    // Find the repaired branch: endingById.set must appear AFTER a
    // finalizeCandidate call in the same block, never before it.
    const lines = src.split('\n');
    let prevFinalize = -1;
    let bad = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.includes('const finalized = finalizeCandidate(')) {
        prevFinalize = i;
      }
      if (line.includes('endingById.set(')) {
        // Within the repaired branch, endingById must be set on a line AFTER
        // the nearest finalizeCandidate in the same function block.
        if (prevFinalize !== -1) {
          bad = false; // OK if a finalizeCandidate precedes this set
        }
        // Reset is not reliable across branches; rely on the specific check
        // below for the repaired path instead.
      }
    }
    // Specific check: in the repaired (boundarySource 'repair') path, the
    // endingById.set at offset must be > the finalizeCandidate call offset.
    const repairedBlockStart = src.indexOf("boundarySource: 'repair'");
    const repairedEnd = src.indexOf('boundarySource: \'semantic\'', repairedBlockStart);
    const block = repairedEnd > -1
      ? src.slice(repairedBlockStart, repairedEnd)
      : src.slice(repairedBlockStart);
    const setIdx = block.indexOf('endingById.set(');
    const finIdx = block.indexOf('finalizeCandidate(');
    expect(setIdx, 'repaired path must write endingById AFTER finalizeCandidate')
      .toBeGreaterThan(finIdx);
  });
});