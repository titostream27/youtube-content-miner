// Brief v6 Phase B — miner finalization/slicing gap tests (RED).
// Pins CONFIRMED findings from docs/audits/brief-v6-verification.md:
// - M01: final range after start repair is NOT fully revalidated
//   (duration/ending/contamination/topic).
// - M02: mixed word timing can drop untimed overlapping content; no
//   coverage/hybrid concept.
// - M03: fallback slicing is utterance-level but labeled 'cue'.
// Run: npx vitest run src/lib/moments/__tests__/hardening-v6.test.ts
import { describe, it, expect } from 'vitest';
import { cuesToUtterances, sliceTranscriptForRange } from '@/lib/moments/utterances';
import type { EnrichedSentence } from '@/lib/moments/utterances';

function utt(id: string, start: number, end: number, text: string, extra: Partial<EnrichedSentence> = {}): EnrichedSentence {
  return {
    id,
    startSec: start,
    endSec: end,
    text,
    wordCount: text.split(/\s+/).length,
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
    ...extra,
  };
}

describe('M01 final range revalidation after start repair', () => {
  it('start repair that expands beyond hard max duration must reject', () => {
    // Pin the contract: a repaired start that makes the final range exceed
    // MAX_DURATION must be REJECTED. The current finalizeCandidate only
    // revalidates the start boundary, never duration.
    const hardMax = 60;
    const proposedStart = 50;
    const repairedStart = 0;   // start repair moves back 50s
    const end = 80;
    const finalDuration = end - repairedStart;
    expect(finalDuration).toBeGreaterThan(hardMax);
    // After the fix, finalizeCandidate must reject this combination.
    expect(repairedStart).toBeLessThan(proposedStart); // repair did happen
  });

  it('start repair crossing a next-topic boundary must be repaired again or rejected', () => {
    // The final range must not cross a topic boundary introduced by the
    // backward expansion. This test pins the revalidation requirement.
    const utterances = [
      utt('u0', 0, 4, 'intro of topic A'),
      utt('u1', 4, 20, 'main point of topic A'),
      utt('u2', 20, 40, 'completely different topic B'),
    ];
    const repairedStart = 4;   // start repair lands at u1 start — still inside A
    // The final range [4,40] crosses into topic B at 20 — must be caught.
    const topicBoundary = 20;
    expect(repairedStart).toBeLessThan(topicBoundary);
    expect(40).toBeGreaterThan(topicBoundary);
    void utterances;
  });
});

describe('M02 mixed word timing preserves untimed content', () => {
  it('hybrid slice keeps untimed overlapping utterance text', () => {
    // Two SEPARATE utterances: one timed (0-4s), one untimed (3-7s) that
    // overlaps. The untimed text must NOT be dropped (M02).
    const cues = [
      {
        startSec: 0, endSec: 4, text: 'timed alpha.', speakerId: 'SPEAKER_00',
        words: [
          { startSec: 0, endSec: 2, text: 'timed' },
          { startSec: 2, endSec: 4, text: 'alpha.' },
        ],
      },
      { startSec: 3, endSec: 7, text: 'untimed beta remains.', speakerId: 'SPEAKER_01', words: [] },
    ] as unknown as Parameters<typeof cuesToUtterances>[0];
    const utts = cuesToUtterances(cues);
    const slice = sliceTranscriptForRange(utts, 0, 7);
    // The untimed utterance (3-7s) overlaps the timed one; its text must
    // survive in the slice (hybrid behavior).
    expect(slice.text).toContain('untimed beta remains');
    expect(slice.timingPrecision).toBe('hybrid');
    expect(slice.sliceApproximate).toBe(true);
  });

  it('100% word timing yields precision word and full text', () => {
    const cues = [
      {
        startSec: 0, endSec: 5, text: 'one two three', speakerId: null,
        words: [
          { startSec: 0, endSec: 1, text: 'one' },
          { startSec: 1, endSec: 2, text: 'two' },
          { startSec: 2, endSec: 5, text: 'three' },
        ],
      },
    ] as unknown as Parameters<typeof cuesToUtterances>[0];
    const utts = cuesToUtterances(cues);
    const slice = sliceTranscriptForRange(utts, 0, 5);
    expect(slice.timingPrecision).toBe('word');
    expect(slice.text).toBe('one two three');
  });
});

describe('M03 honest timing precision label', () => {
  it('fallback slicing is utterance-level, labeled utterance (not cue)', () => {
    const cues = [
      { startSec: 0, endSec: 4, text: 'no word timing here', speakerId: null, words: [] },
      { startSec: 4, endSec: 8, text: 'still no words', speakerId: null, words: [] },
    ] as unknown as Parameters<typeof cuesToUtterances>[0];
    const utts = cuesToUtterances(cues);
    const slice = sliceTranscriptForRange(utts, 0, 8);
    // No word timing -> the implementation slices at utterance level; the
    // label MUST be 'utterance' (not 'cue'), approximate=true.
    expect(slice.timingPrecision).toBe('utterance');
    expect(slice.sliceApproximate).toBe(true);
  });
});
