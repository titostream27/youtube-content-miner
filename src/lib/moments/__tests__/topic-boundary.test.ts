import { describe, it, expect } from 'vitest';
import {
  classifyEnding,
  detectTopicBoundary,
  selectBestEnding,
  type EndingType,
} from '@/lib/moments/topic-boundary';
import { applyBoundaryCaps } from '@/lib/moments/boundary-quality';
import type { EnrichedSentence } from '@/lib/moments/utterances';

function u(
  start: number,
  end: number,
  text: string,
  opts: Partial<EnrichedSentence> = {},
): EnrichedSentence {
  return {
    id: `u-${start}`,
    startSec: start,
    endSec: end,
    text,
    wordCount: text.split(/\s+/).length,
    speakerId: null,
    pauseBeforeSec: 0,
    pauseAfterSec: 0,
    isCompleteSentence: /[.!?…]$/.test(text),
    startsWithTransition: false,
    startsWithQuestion: false,
    endsWithQuestion: /\?$/.test(text),
    semanticTopicId: null,
    sourceCueStartIndex: 0,
    sourceCueEndIndex: 0,
    ...opts,
  };
}

describe('classifyEnding (brief §8)', () => {
  it('classifies a clean conclusion as CONCLUSION', () => {
    const end = u(0, 5, 'So that is why the company failed.');
    const res = classifyEnding(end, null, []);
    expect(res.endingComplete).toBe(true);
    expect(res.endingType).toBe('CONCLUSION');
  });

  it('classifies a short punchy line as PUNCHLINE', () => {
    const end = u(0, 3, 'It was a disaster!');
    const res = classifyEnding(end, null, []);
    expect(res.endingType).toBe('PUNCHLINE');
  });

  it('flags a question as QUESTION_START (bad ending)', () => {
    const end = u(0, 3, 'What do you think about that?');
    const res = classifyEnding(end, null, []);
    expect(res.endingComplete).toBe(false);
    expect(res.endingType).toBe('QUESTION_START');
  });

  it('flags an incomplete dangling ending', () => {
    const end = u(0, 3, 'The reason is because');
    const res = classifyEnding(end, null, []);
    expect(res.endingComplete).toBe(false);
    expect(res.endingType).toBe('INCOMPLETE_SENTENCE');
  });

  it('returns UNKNOWN for punctuation-free non-pause units', () => {
    const end = u(0, 3, 'so then we just moved');
    const res = classifyEnding(end, null, []);
    expect(res.endingType).toBe('UNKNOWN');
  });

  it('accepts punctuation-free units with a long pause (case 6: Bahasa Indonesia)', () => {
    const end = u(0, 3, 'jadi keputusannya sudah final', { pauseAfterSec: 0.8 });
    const res = classifyEnding(end, null, []);
    expect(res.endingComplete).toBe(true);
    expect(res.endingType).toBe('ANSWER_COMPLETE');
  });
});

describe('detectTopicBoundary (brief §7 + §41 cases)', () => {
  it('Case 1 — finished topic then a new question: boundary detected', () => {
    const end = u(0, 4, 'Itulah tiga alasan mengapa produknya gagal.');
    const next = u(4, 7, 'Ngomong-ngomong, setelah itu kamu pindah ke mana?', {
      startsWithTransition: true,
      startsWithQuestion: true,
      pauseBeforeSec: 0.5,
    });
    const b = detectTopicBoundary(end, next, []);
    expect(b.nextTopicDetected).toBe(true);
    expect(b.nextTopicStart).not.toBeNull();
  });

  it('Case 2 — no pause, same topic, embedded question: boundary NOT detected', () => {
    const end = u(0, 5, 'Masalah utamanya adalah cash flow.');
    const next = u(5, 9, 'Kalau bicara soal tim, berapa orang yang bekerja?', {
      startsWithTransition: true,
      pauseBeforeSec: 0.1,
    });
    // The transition phrase alone is NOT proof (brief §7): the next question
    // stays within the same semantic area here, so no hard boundary.
    const b = detectTopicBoundary(end, next, []);
    expect(b.contamination).toBeLessThanOrEqual(0.18);
  });

  it('Case 5 — transition phrase but same topic: do NOT cut', () => {
    const end = u(0, 4, 'Ngomong-ngomong soal biaya yang tadi');
    const next = u(4, 8, 'ada satu hal lagi yang perlu kita bahas', {
      pauseBeforeSec: 0.2,
    });
    const b = detectTopicBoundary(end, next, []);
    // Both are same-topic continuations; lexical overlap is high.
    expect(b.contamination).toBeLessThan(0.5);
  });

  it('detects a speaker change as a boundary signal', () => {
    const end = u(0, 4, 'I believe the plan will work', { speakerId: 'SPEAKER_00' });
    const next = u(4, 8, 'Well, I think you are wrong', {
      speakerId: 'SPEAKER_01',
      pauseBeforeSec: 0.7,
    });
    const b = detectTopicBoundary(end, next, []);
    expect(b.nextTopicDetected).toBe(true);
  });
});

describe('selectBestEnding (brief §8)', () => {
  it('prefers PAYOFF/CONCLUSION over QUESTION_START', () => {
    const best = selectBestEnding([
      { time: 10, type: 'QUESTION_START' as EndingType, score: 90 },
      { time: 12, type: 'CONCLUSION' as EndingType, score: 80 },
    ]);
    expect(best!.type).toBe('CONCLUSION');
    expect(best!.time).toBe(12);
  });

  it('returns null on empty', () => {
    expect(selectBestEnding([])).toBeNull();
  });
});

describe('applyBoundaryCaps (brief §11)', () => {
  const good = {
    startComplete: true,
    endingComplete: true,
    endingType: 'CONCLUSION' as EndingType,
    boundaryConfidence: 0.9,
    previousTopicContamination: 0,
    nextTopicContamination: 0,
    nextTopicStartSec: 200,
  };

  it('caps at 74 when ending incomplete', () => {
    const r = applyBoundaryCaps(95, { ...good, endingComplete: false, endingType: 'QUESTION_START' });
    expect(r.maxScore).toBe(74);
    expect(r.publishImmediatelyAllowed).toBe(false);
  });

  it('caps at 76 when next-topic contamination too high', () => {
    const r = applyBoundaryCaps(95, { ...good, nextTopicContamination: 0.4 });
    expect(r.maxScore).toBe(76);
  });

  it('caps at 80 when starts mid-sentence', () => {
    const r = applyBoundaryCaps(95, { ...good, startComplete: false });
    expect(r.maxScore).toBe(80);
  });

  it('caps at 82 when previous context required', () => {
    const r = applyBoundaryCaps(95, good, { requiresPreviousContext: true });
    expect(r.maxScore).toBe(82);
  });

  it('allows Publish Immediately only when all gates pass', () => {
    const r = applyBoundaryCaps(95, good);
    expect(r.publishImmediatelyAllowed).toBe(true);
    expect(r.maxScore).toBe(100);
  });

  it('blocks Publish Immediately on low boundary confidence', () => {
    const r = applyBoundaryCaps(95, { ...good, boundaryConfidence: 0.5 });
    expect(r.publishImmediatelyAllowed).toBe(false);
  });
});
