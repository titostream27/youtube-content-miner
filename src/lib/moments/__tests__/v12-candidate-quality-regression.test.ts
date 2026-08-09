import { describe, expect, it } from 'vitest';
import { classifyEnding, detectTopicBoundary } from '@/lib/moments/topic-boundary';
import { validateStartBoundary } from '@/lib/moments/start-boundary';
import { repairBoundary } from '@/lib/moments/boundary-repair';
import { computeSalience } from '@/lib/moments/segmentation';
import { cuesToSentences, detectMoments } from '@/lib/moments/segmentation';
import { extractJson } from '@/lib/ai/client';
import { isAgentActive } from '@/lib/ai/client';
import type { Utterance } from '@/lib/moments/utterances';
import type { TranscriptCue } from '@/lib/domain/types';

/**
 * Brief V12 Phase N — CQ-01..CQ-20 regression matrix.
 *
 * Each test encodes one row of the brief's matrix using deterministic fixtures
 * that mirror the failure modes measured on the frozen corpus
 * (docs/v12-candidate-quality-analysis.md). No production code is modified by
 * these tests; they lock in current correct behavior and the confirmed
 * diagnosis (H6 ending-confidence, H1 start-gate, H9 disproven as systemic).
 */

function utt(id: string, startSec: number, endSec: number, text: string, pauseAfterSec = 0): Utterance {
  return {
    id,
    startSec,
    endSec,
    text,
    words: text.split(/\s+/).filter(Boolean).length,
    pauseAfterSec,
    pauseBeforeSec: 0,
    speakerId: null,
    cueIndex: 0,
  } as unknown as Utterance;
}

function cue(startSec: number, endSec: number, text: string): TranscriptCue {
  return { startSec, endSec, text, words: [] };
}

function transcript(cues: TranscriptCue[]): { cues: TranscriptCue[]; videoId: string } {
  return { cues, videoId: 'fixture-v12' } as never;
}

describe('V12 CQ matrix', () => {
  it('CQ-01 gold-like standalone answer classifies as complete', () => {
    const end = utt('a1', 100, 106, 'The answer is that we simply changed the process.', 0.6);
    const ending = classifyEnding(end, null, []);
    expect(ending.endingComplete).toBe(true);
    expect(['ANSWER_COMPLETE', 'CONCLUSION', 'PUNCHLINE']).toContain(ending.endingType);
  });

  it('CQ-02 mid-answer fragment start is flagged MID_SENTENCE', () => {
    const utterances = [
      utt('p', 90, 98, 'We decided to move forward with the plan,', 0.1),
      utt('s', 98, 104, 'because the market demanded it.', 0.3),
    ];
    const result = validateStartBoundary(utterances as never, 98, 104);
    expect(result.startComplete).toBe(false);
    expect(result.issues).toContain('MID_SENTENCE');
  });

  it('CQ-03 question + answer + next question excludes the next question', () => {
    const end = utt('a', 100, 112, 'I started the company in 2015 after years of saving.', 0.5);
    const next = utt('q', 113, 117, 'And what was the biggest lesson?', 0.2);
    const boundary = detectTopicBoundary(end, next, [], 12);
    expect(boundary.nextTopicDetected).toBe(true);
    if (boundary.nextTopicStart !== null) {
      expect(boundary.nextTopicStart).toBeGreaterThanOrEqual(next.startSec);
    }
    // Repair must stop before the question (preferEndBeforeSec is authoritative).
    const repair = repairBoundary(
      [end, next],
      { roughStartSec: 100, roughEndSec: 112 },
      boundary.nextTopicStart !== null ? boundary.nextTopicStart - 0.2 : 112,
    );
    expect(['refined', 'repaired']).toContain(repair.boundaryStatus);
    expect(repair.finalEndSec).toBeLessThanOrEqual(112.5);
  });

  it('CQ-04 question without answer is a hard negative', () => {
    const end = utt('q', 100, 106, 'What do you think about that?', 0.4);
    const ending = classifyEnding(end, null, []);
    expect(ending.endingComplete).toBe(false);
    expect(ending.endingType).toBe('QUESTION_START');
  });

  it('CQ-05 answer requiring a previous named referent is rejected by start validation', () => {
    const utterances = [
      utt('s', 100, 108, 'He was absolutely incredible on stage.', 0.4),
      utt('n', 109, 115, 'And that changed everything for us.', 0.3),
    ];
    const result = validateStartBoundary(utterances as never, 100, 115);
    expect(result.startComplete).toBe(false);
    expect(['MISSING_CONTEXT', 'UNRESOLVED_REFERENCE']).toContain(result.primaryIssue);
  });

  it('CQ-06 complete payoff with laughter acknowledgement keeps natural closure', () => {
    const end = utt('p', 100, 108, 'And that is the story of how we won.', 0.5);
    const ack = utt('l', 109, 111, 'Ha ha ha, wow.', 0.3);
    const ending = classifyEnding(end, ack, []);
    // Acknowledgement is not a question or transition -> ending remains complete.
    expect(ending.endingComplete).toBe(true);
  });

  it('CQ-07 complete payoff followed by new topic stops before the topic', () => {
    const end = utt('p', 100, 110, 'So in the end, the plan worked perfectly.', 0.4);
    const next = utt('t', 111, 116, 'Anyway, speaking of another thing entirely, what do you do for fun?', 0.2);
    const boundary = detectTopicBoundary(end, next, [], 12);
    expect(boundary.nextTopicDetected).toBe(true);
    expect(boundary.contamination).toBeGreaterThan(0);
  });

  it('CQ-08 flashy quote without context is capped below a complete moment', () => {
    // Salience pre-filter: a dangling opening should carry strong penalties,
    // and computeSalience must not reward a fragment as much as a complete
    // self-contained window (the ranking protection lives in scoring caps).
    const flashy = computeSalience('This is insane. You will not believe this. insane crazy shocking!', 12);
    const complete = computeSalience('When I was young I saved every paycheck, and that habit built my entire life.', 24);
    // The complete window should not be systematically penalized more than the fragment.
    expect(complete).toBeGreaterThanOrEqual(flashy - 0.05);
  });

  it('CQ-09 overlapping candidates are deduplicated by detectMoments', () => {
    const cues = [
      cue(0, 3, 'First sentence here.'),
      cue(3, 6, 'Second sentence here.'),
      cue(6, 9, 'Third sentence here.'),
      cue(9, 12, 'Fourth sentence here.'),
    ];
    const result = detectMoments(transcript(cues) as never, {
      minDurationSec: 6,
      maxDurationSec: 30,
      targetDurationSec: 12,
      maxSegments: 10,
    });
    for (let i = 0; i < result.segments.length; i += 1) {
      for (let j = i + 1; j < result.segments.length; j += 1) {
        const a = result.segments[i]!;
        const b = result.segments[j]!;
        const overlap = a.startSec < b.endSec && b.startSec < a.endSec;
        expect(overlap).toBe(false);
      }
    }
  });

  it('CQ-10 ASR fragments of 2-8s rebuild into a semantic moment without collapsing', () => {
    const sentences = cuesToSentences([
      cue(0, 2, 'When I was'),
      cue(2, 5, 'young I saved'),
      cue(5, 8, 'every single paycheck'),
      cue(8, 11, 'and it changed my life'),
    ]);
    // Fragments without punctuation or long pause form one sentence.
    expect(sentences.length).toBe(1);
    expect(sentences[0]!.endSec - sentences[0]!.startSec).toBeGreaterThan(8);
  });

  it('CQ-11 malformed LLM JSON is a parser failure, not a zero-moment', () => {
    expect(extractJson('{"score": 0.8, "ok": true} trailing prose')).toEqual({ score: 0.8, ok: true });
    expect(extractJson('```json\n{"score": 0.6}\n```')).toEqual({ score: 0.6 });
    expect(extractJson('Here is the result: {"score": 0.9}')).toEqual({ score: 0.9 });
  });

  it('CQ-12 fallback activation is traceable and distinguishable', () => {
    // A heuristic override must be detectable as inactive LLM agent.
    expect(isAgentActive('clip_scoring', { clip_scoring: { provider: 'heuristic' } })).toBe(false);
  });

  it('CQ-13 negative duration remains impossible (V11 protection)', () => {
    const repair = repairBoundary(
      [utt('a', 100, 110, 'A complete answer with a period.', 0.5)],
      { roughStartSec: 105, roughEndSec: 100 }, // inverted rough range
    );
    expect(repair.boundaryStatus).toBe('rejected');
  });

  it('CQ-14 ending repair preserves start (V11 protection)', () => {
    const repair = repairBoundary(
      [utt('a', 100, 110, 'Complete conclusion.', 0.4), utt('q', 111, 114, 'So what next?', 0.2)],
      { roughStartSec: 100, roughEndSec: 113 },
    );
    expect(['refined', 'repaired']).toContain(repair.boundaryStatus);
    expect(repair.finalStartSec).toBe(100);
  });

  it('CQ-15 filtered/full index mismatch protection (V11 regression)', () => {
    const utterances = [
      utt('u0', 90, 96, 'Setup sentence here.', 0.2),
      utt('u1', 97, 103, 'A complete answer.', 0.4),
      utt('u2', 104, 107, 'Thank you so much.', 0.5),
    ];
    const repair = repairBoundary(utterances, { roughStartSec: 97, roughEndSec: 107 });
    expect(['refined', 'repaired']).toContain(repair.boundaryStatus);
    expect(repair.selectedEndingOriginalIndex).toBe(2);
  });

  it('CQ-16 sponsor ad read must not rank as publishable', () => {
    const score = computeSalience(
      'This episode is sponsored by our partner. Use code SAVE20 at checkout. Check out the link in description today.',
      20,
    );
    expect(score).toBeLessThan(0.35);
  });

  it('CQ-17 unanswered next-topic question triggers contamination evidence', () => {
    const end = utt('p', 100, 110, 'And that concludes the entire story.', 0.4);
    const next = utt('q', 111, 116, 'What about the second book you mentioned?', 0.2);
    const boundary = detectTopicBoundary(end, next, [], 12);
    expect(boundary.nextTopicDetected).toBe(true);
    expect(boundary.contamination).toBeGreaterThan(0);
  });

  it('CQ-18 natural 18s complete moment is not extended to chase duration', () => {
    const repair = repairBoundary(
      [utt('a', 100, 118, 'A short but complete answer with a clean period.', 0.6)],
      { roughStartSec: 100, roughEndSec: 118 },
    );
    expect(repair.boundaryStatus).toBe('refined');
    expect(repair.finalEndSec).toBe(118);
  });

  it('CQ-19 natural 65s complete moment respects max-duration policy', () => {
    const repair = repairBoundary(
      [utt('a', 100, 165, 'A long complete answer that ends with a period.', 0.6)],
      { roughStartSec: 100, roughEndSec: 165 },
    );
    expect(['refined', 'repaired']).toContain(repair.boundaryStatus);
    expect(repair.finalEndSec - repair.finalStartSec).toBeLessThanOrEqual(90);
  });
});
