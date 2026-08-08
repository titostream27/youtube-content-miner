/**
 * Brief V12R Phase I — H6 pause-aware ending confidence (counterfactual).
 *
 * This module is EXPERIMENTAL ONLY. It never changes production code. It
 * computes pause/semantic closure features from the frozen-corpus utterances
 * and derives an `experimental_confidence` that the V12R report compares
 * against the silver-gold consensus labels. A long pause must NOT rescue an
 * obviously unfinished thought, and next-topic leakage stays a hard negative
 * signal (brief §12.1).
 */
import type { Utterance } from '@/lib/moments/utterances';

export interface H6Features {
  current_confidence: number;
  punctuation_feature: 'none' | 'sentence_end' | 'question_end';
  pause_after_end_ms: number;
  speaker_change_after_end: boolean;
  semantic_closure_features: {
    ends_with_sentence_punctuation: boolean;
    ends_with_question: boolean;
    dangling_ending: boolean;
    word_count: number;
  };
  next_topic_features: {
    next_is_question: boolean;
    next_has_transition: boolean;
    next_incomplete: boolean;
    next_speaker_change: boolean;
  };
  experimental_confidence: number;
  current_decision: 'ACCEPT' | 'REJECT';
  experimental_decision: 'ACCEPT' | 'REJECT';
}

const SENTENCE_END_RE = /[.!?…]["')\]]?\s*$/;
const QUESTION_END_RE = /\?\s*$/;
const DANGLING_END_RE = /\b(the|a|an|and|but|or|because|so|if|with|of|to|in|on|at|for|yang|dan|terus|tapi|karena)\s*$/i;
const QUESTION_START_RE = /\b(how|what|why|when|where|who|do you|did you|can you|could you|would you|are you|is it|have you|berapa|bagaimana|kenapa|mengapa|apa|siapa|kapan|apakah)\b/i;
const TRANSITION_RE = /\b(by the way|moving on|another question|speaking of|next up|so next|anyway|ngomong-ngomong|selanjutnya|pertanyaan berikutnya|ada hal lain|topik lain)\b/i;

export const H6_MIN_ENDING_CONFIDENCE = 0.82; // production threshold (frozen)

export function analyzeEndingPause(
  window: { startSec: number; endSec: number },
  utterances: Utterance[],
  currentConfidence: number,
): H6Features | null {
  const last = [...utterances].reverse().find((u) => u.endSec <= window.endSec + 0.05 && u.startSec < window.endSec);
  if (!last) return null;
  const next = utterances.find((u) => u.startSec >= last.endSec - 0.05 && u.startSec >= window.endSec - 0.05) ?? null;

  const text = last.text.trim();
  const endsSentence = SENTENCE_END_RE.test(text);
  const endsQuestion = QUESTION_END_RE.test(text);
  const dangling = DANGLING_END_RE.test(text) && !endsSentence;
  const pauseAfterMs = Math.round(last.pauseAfterSec * 1000);
  const speakerChange = Boolean(
    next && last.speakerId && next.speakerId && last.speakerId !== next.speakerId,
  );

  const nextIsQuestion = next ? QUESTION_START_RE.test(next.text.trim().split(/\s+/).slice(0, 2).join(' ')) : false;
  const nextTransition = next ? TRANSITION_RE.test(next.text.trim()) : false;
  const nextIncomplete = next ? DANGLING_END_RE.test(next.text.trim()) && !SENTENCE_END_RE.test(next.text.trim()) : false;
  const nextSpeakerChange = speakerChange;

  // Pause-aware experimental confidence. Never exceeds what the semantics
  // justify: a long pause alone cannot rescue an unfinished thought, and an
  // unanswered question ending is a hard negative (brief §12.1, AJ-09).
  let experimental = currentConfidence;
  if (dangling || endsQuestion) {
    experimental = Math.min(experimental, 0.45);
  } else {
    if (pauseAfterMs >= 500) experimental += 0.06;
    else if (pauseAfterMs >= 250) experimental += 0.03;
    if (speakerChange) experimental += 0.02;
    if (endsSentence) experimental += 0.02;
  }
  if (nextIsQuestion || nextTransition || nextIncomplete) {
    experimental -= 0.2; // next-topic leakage must remain a hard negative (brief §12.1)
  }
  experimental = Math.max(0, Math.min(1, Math.round(experimental * 100) / 100));

  return {
    current_confidence: currentConfidence,
    punctuation_feature: endsQuestion ? 'question_end' : endsSentence ? 'sentence_end' : 'none',
    pause_after_end_ms: pauseAfterMs,
    speaker_change_after_end: speakerChange,
    semantic_closure_features: {
      ends_with_sentence_punctuation: endsSentence,
      ends_with_question: endsQuestion,
      dangling_ending: dangling,
      word_count: last.wordCount,
    },
    next_topic_features: {
      next_is_question: nextIsQuestion,
      next_has_transition: nextTransition,
      next_incomplete: nextIncomplete,
      next_speaker_change: nextSpeakerChange,
    },
    experimental_confidence: experimental,
    current_decision: currentConfidence >= H6_MIN_ENDING_CONFIDENCE ? 'ACCEPT' : 'REJECT',
    experimental_decision: experimental >= H6_MIN_ENDING_CONFIDENCE ? 'ACCEPT' : 'REJECT',
  };
}