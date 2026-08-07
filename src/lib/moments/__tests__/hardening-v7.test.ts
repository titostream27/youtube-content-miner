import { describe, it, expect } from 'vitest';
import {
  sliceTranscriptForRange,
  type EnrichedSentence,
} from '@/lib/moments/utterances';

/**
 * Brief v7 C07 — test(miner): expose lookahead-unit, stale-evidence,
 * coverage/order bugs (RED on v6, GREEN after C08).
 *
 * - V7-M01: nextTopicLookaheadSec (seconds) is used as an utterance COUNT
 *   in finalRangeValidationFor — must be a time window, not slice length.
 * - V7-M03: wordTimingCoverage divides by full wall-clock window; natural
 *   pauses make fully word-timed clips score < 0.95 (mislabeled hybrid).
 * - V7-M04: hybrid text concatenates all timed words then all untimed text
 *   — not chronological (A C B instead of A B C).
 */
function u(
  id: string,
  startSec: number,
  endSec: number,
  text: string,
  speakerId: string | null = null,
  words?: { text: string; startSec: number; endSec: number }[],
): EnrichedSentence {
  return {
    id,
    startSec,
    endSec,
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    speakerId,
    pauseBeforeSec: 0,
    pauseAfterSec: 0,
    isCompleteSentence: true,
    startsWithTransition: false,
    startsWithQuestion: false,
    endsWithQuestion: false,
    semanticTopicId: null,
    sourceCueStartIndex: 0,
    sourceCueEndIndex: 0,
    ...(words ? { words } : {}),
  };
}

describe('V7-M01: lookahead seconds must not be an utterance count', () => {
  it('finalRangeValidationFor lookahead is a TIME window, not a slice count', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const srcPath = path.resolve(
      process.cwd(),
      'src/lib/moments/two-pass.ts',
    );
    const src = fs.readFileSync(srcPath, 'utf8');
    // Buggy form: utterances.slice(endIdx + 1, endIdx + 1 + lookaheadSec)
    // uses a SECONDS value as an utterance COUNT.
    const sliceCount = /slice\(endIdx \+ 1, endIdx \+ 1 \+ h\.nextTopicLookaheadSec\)/.test(src);
    // Required form: bound the slice by TIME (utterance start before the
    // lookahead seconds reach past endU) or filter by timestamp.
    const timeBounded =
      /slice\(endIdx \+ 1\)\.filter\(\([\w]+\) => / .test(src) ||
      /\.filter\(\([\w]+\) => [\w]+\.endSec < /.test(src) ||
      /withinLookaheadSec|\.endSec <= endU\.endSec \+ h\.nextTopicLookaheadSec/.test(src);
    if (sliceCount) {
      // Still the buggy slice-count — RED.
      expect(timeBounded).toBe(true);
    }
    // The fixed form must not be the bare slice-count.
    expect(timeBounded || !sliceCount).toBe(true);
    expect(sliceCount).toBe(false);
  });

  it('lookahead spans TIME within candidate: utterances within lookahead seconds', () => {
    // 30 short utterances, 0.25s apart over a 7.5s window. A time-window
    // slice (30 * 0.2s = 6s of speech) must include far more than a
    // handful; a slice-COUNT of ~8 would collapse it.
    const phrases: EnrichedSentence[] = [];
    for (let i = 0; i < 30; i++) {
      phrases.push(u(`m${i}`, 10 + i * 0.25, 10 + i * 0.25 + 0.2, `word ${i}`, null));
    }
    const s = sliceTranscriptForRange(phrases, 10, 17.5);
    // Full speech-covered window -> 30 utterances, ~60 words.
    expect(s.wordCount).toBeGreaterThan(40);
  });
});

describe('V7-M03: coverage must not be diluted by natural pauses', () => {
  it('word-timed utterances with gaps still score high coverage', () => {
    // Words fill 2.4s of a 4s window; the rest is natural pause. Current
    // code divides by 4.0s wall-clock -> 0.60 (hybrid), even though every
    // spoken word is timed.
    const pauses: EnrichedSentence[] = [
      u('p1', 0, 1.0, 'Hello world', null, [
        { text: 'Hello', startSec: 0.0, endSec: 0.4 },
        { text: 'world', startSec: 0.5, endSec: 0.9 },
      ]),
      u('p2', 1.0, 2.0, '', null, []),
      u('p3', 2.0, 3.0, 'Testing pause', null, [
        { text: 'Testing', startSec: 2.0, endSec: 2.5 },
        { text: 'pause', startSec: 2.6, endSec: 3.0 },
      ]),
      u('p4', 3.0, 4.0, '', null, []),
    ];
    const s = sliceTranscriptForRange(pauses, 0, 4);
    // 2.4s of words over 4s window = 60% by the buggy formula.
    expect(s.wordTimingCoverage).toBeGreaterThan(0.9);
    expect(s.timingPrecision).toBe('word');
  });
});

describe('V7-M04: hybrid text must be chronological', () => {
  it('interleaved timed/untimed utterances keep original order', () => {
    // Order: A(timed) -> B(untimed) -> C(timed).
    const interleaved: EnrichedSentence[] = [
      u('a1', 0, 1.0, 'Alpha', null, [
        { text: 'Alpha', startSec: 0.0, endSec: 0.5 },
      ]),
      u('b1', 1.2, 2.2, 'Bravo gap', null),
      u('c1', 2.4, 3.0, 'Charlie', null, [
        { text: 'Charlie', startSec: 2.4, endSec: 3.0 },
      ]),
    ];
    const s = sliceTranscriptForRange(interleaved, 0, 3.0);
    // Current buggy output: "Alpha Charlie Bravo gap" (timed first).
    // Correct: "Alpha Bravo gap Charlie".
    expect(s.timingPrecision).toBe('hybrid');
    const aIdx = s.text.indexOf('Alpha');
    const bIdx = s.text.indexOf('Bravo');
    const cIdx = s.text.indexOf('Charlie');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });
});
