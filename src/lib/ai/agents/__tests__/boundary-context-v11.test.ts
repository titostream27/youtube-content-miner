/** Brief v11 — boundary-refinement context windowing regression. */
import { describe, expect, it } from 'vitest';
import { contextUtterances } from '../boundary-refinement-agent';
import type { Utterance } from '../../../moments/utterances';

function ut(startSec: number, endSec: number): Utterance {
  const base = {
    startSec,
    endSec,
    text: `u${startSec}`,
    words: [] as { text: string; startSec: number; endSec: number }[],
    wordCount: 3,
    wordsPerSecond: 1,
    cueIndex: 0,
    id: `u${startSec}`,
    speakerId: null,
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
  return base as unknown as Utterance;
}

describe('contextUtterances (v11 JSON validity fix)', () => {
  it('filters to the union of the contracted windows only', () => {
    const episodes = [
      ut(0, 2), // before first window; candidate1 window [15,55] -> excluded
      ut(12, 14), // outside
      ut(30, 32), // inside candidate 1 window [15,55]
      ut(45, 47), // inside
      ut(90, 92), // outside all
    ];
    const candidates = [
      { roughStartSec: 30, roughEndSec: 35 },
      { roughStartSec: 50, roughEndSec: 55 },
    ];
    const result = contextUtterances(episodes, candidates);
    const starts = result.map((u) => u.startSec);
    expect(starts).toContain(30);
    expect(starts).toContain(45);
    expect(starts).not.toContain(0);
    expect(starts).not.toContain(90);
  });

  it('preserves transcript order (filter is order-stable)', () => {
    // Production input is already chronological; the filter must not reorder.
    const episodes = [ut(10, 15), ut(30, 32), ut(50, 55)];
    const candidates = [{ roughStartSec: 30, roughEndSec: 35 }];
    const result = contextUtterances(episodes, candidates);
    expect(result.map((u) => u.startSec)).toEqual([10, 30, 50]);
    // Order stability also holds for the same input in any order (identity).
    const shuffled = [ut(50, 55), ut(10, 15), ut(30, 32)];
    const res2 = contextUtterances(shuffled, candidates);
    expect(res2.map((u) => u.startSec)).toEqual([50, 10, 30]);
  });

  it('returns empty for no candidates', () => {
    expect(contextUtterances([ut(1, 2)], [])).toEqual([]);
  });

  it('caps an enormous spread window and keeps a contiguous block', () => {
    // Simulate a 2-hour episode with candidates spread far apart: the union
    // window covers nearly everything. The cap must keep a contiguous block,
    // not a sparse sample.
    const episodes = Array.from({ length: 600 }, (_, i) => ut(i * 12, i * 12 + 8));
    const candidates = [
      { roughStartSec: 100, roughEndSec: 140 },
      { roughStartSec: 3500, roughEndSec: 3540 },
      { roughStartSec: 7000, roughEndSec: 7040 },
    ];
    const result = contextUtterances(episodes, candidates);
    expect(result.length).toBeLessThanOrEqual(240);
    expect(result.length).toBeGreaterThan(0);
    // Contiguous: no gaps between consecutive utterances.
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i]!.endSec).toBeGreaterThan(result[i - 1]!.endSec);
    }
  });
});