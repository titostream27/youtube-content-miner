import type { MomentSegment } from '@/lib/domain/types';

export interface FinalizedSlice {
  text: string;
  wordCount: number;
  wordsPerSecond: number;
  speakerTurns: number;
}

/**
 * Hardening v3 C5 (#18): recompute ALL boundary-sensitive metrics from the
 * FINAL transcript slice, never inherit them from the rough candidate.
 *
 * Returns a NEW segment object (the input is not mutated). Salience, lexical
 * richness, speech density and every value that depends on the window text
 * are derived from the final slice.
 */
export function rescoreSegmentFromSlice(
  rough: MomentSegment,
  slice: FinalizedSlice,
): MomentSegment {
  // Speech density / word-count come straight from the final slice.
  const wordCount = slice.wordCount;
  const durationSec = Math.max(0.5, rough.endSec - rough.startSec);
  const wordsPerSecond = Number(
    (wordCount / durationSec).toFixed(3),
  );
  // Lexical richness (unique-word ratio) of the FINAL text — cheap, honest
  // salience proxy recomputed from the actual window, not the rough one.
  const tokens = slice.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const unique = new Set(tokens).size;
  const lexicalSalience = tokens.length > 0 ? unique / tokens.length : 0;
  const baseSalience = Math.min(1, lexicalSalience + (slice.speakerTurns > 0 ? 0.05 : 0));

  return {
    ...rough,
    text: slice.text,
    wordCount,
    wordsPerSecond,
    salience: Number(baseSalience.toFixed(3)),
  };
}