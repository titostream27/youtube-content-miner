/** Brief v11 C6 — repaired path must use time-based lookahead. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('F11-06: repaired candidate lookahead uses seconds', () => {
  it('contains no fixed three-utterance repaired slice', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/moments/two-pass.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/utterances\.slice\(repEndIdx \+ 1, repEndIdx \+ 4\)/);
    expect(src).toMatch(/followingWithinLookaheadSec\(\s*utterances,\s*repEndIdx/);
  });

  it('keeps both short-utterance and long-utterance horizons time-based', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/moments/two-pass.ts'),
      'utf8',
    );
    const repairedCall = src.match(
      /followingWithinLookaheadSec\(\s*utterances,\s*repEndIdx,[\s\S]{0,800}?nextTopicLookaheadSec\)/,
    );
    expect(repairedCall, 'repaired branch must pass configured seconds horizon').not.toBeNull();
  });
});

// Keep this file executable under Vitest without importing private helpers.
void path;
void fs;
void describe;
void expect;
void it;
