/**
 * Brief V12R Phase J — H1 valid-setup start expansion (counterfactual).
 *
 * EXPERIMENTAL ONLY — never modifies production. For candidates rejected at
 * the start gate, search backward within a bounded window for a valid setup
 * (earlier question, sentence start, referent introduction or topic setup),
 * snap to utterance boundaries, never cross into the previous unrelated
 * topic, and return a reason code. Judge hints stay advisory; deterministic
 * boundary logic controls the final timestamps (brief §13).
 */
import type { Utterance } from '@/lib/moments/utterances';

export type H1ReasonCode =
  | 'NO_REPAIR_NEEDED'
  | 'EXPAND_TO_QUESTION'
  | 'EXPAND_TO_SENTENCE_START'
  | 'EXPAND_TO_REFERENT_SETUP'
  | 'EXPAND_TO_TOPIC_SETUP'
  | 'REJECT_NO_VALID_SETUP'
  | 'REJECT_WOULD_CROSS_TOPIC'
  | 'REJECT_DURATION_LIMIT';

export interface H1Result {
  reason_code: H1ReasonCode;
  original_start_sec: number;
  original_end_sec: number;
  expanded_start_sec: number | null;
  expanded_end_sec: number | null;
  expanded_duration_sec: number | null;
  candidate_text_excerpt: string;
  setup_text_excerpt: string | null;
  crossed_topic: boolean;
  duration_limit_hit: boolean;
  found_setup: boolean;
}

const QUESTION_START_RE =
  /^(how|what|why|when|where|who|do you|did you|can you|could you|would you|are you|is it|have you|berapa|bagaimana|kenapa|mengapa|apa|siapa|kapan|di mana|apakah)\b/i;
const REFERENT_RE =
  /\b(Mr|Ms|Mrs|Dr|Prof|guest|coach|host|founder|doctor|company|startup|business|product|CEO|CTO|president|manager|boss|wife|husband|partner|elon|steve|bill|tim|sarah|jadi|ada|orang|tim|bos)\b/i;
const TOPIC_TRANSITION_RE = /\b(by the way|moving on|another question|speaking of|next up|so next|anyway|ngomong-ngomong|selanjutnya|pertanyaan berikutnya|ada hal lain|topik lain|oke sekarang)\b/i;
const SENTENCE_END_RE = /[.!?…]["')\]]?\s*$/;

export interface H1Options {
  /** Bounded backward search window in seconds. Default 40. */
  maxSearchBackSec?: number;
  /** Hard max duration after expansion. Default 60. */
  hardMaxSec?: number;
  /** Minimum acceptable duration. Default 14. */
  minDurSec?: number;
}

export function expandStartToValidSetup(
  window: { startSec: number; endSec: number },
  utterances: Utterance[],
  opts: H1Options = {},
): H1Result {
  const maxSearchBack = opts.maxSearchBackSec ?? 40;
  const hardMax = opts.hardMaxSec ?? 60;
  const minDur = opts.minDurSec ?? 14;

  const originalStart = window.startSec;
  const originalEnd = window.endSec;
  const originalDur = originalEnd - originalStart;

  if (originalDur > hardMax) {
    return {
      reason_code: 'REJECT_DURATION_LIMIT',
      original_start_sec: originalStart,
      original_end_sec: originalEnd,
      expanded_start_sec: null,
      expanded_end_sec: null,
      expanded_duration_sec: null,
      candidate_text_excerpt: excerpt(utterances, originalStart, originalEnd),
      setup_text_excerpt: null,
      crossed_topic: false,
      duration_limit_hit: true,
      found_setup: false,
    };
  }

  // Candidates whose opening already looks like a fresh start need no repair.
  const firstInside = utterances.find((u) => u.endSec > originalStart && u.startSec < originalEnd);
  if (firstInside && !isMidContextStart(firstInside, utterances, originalStart)) {
    return {
      reason_code: 'NO_REPAIR_NEEDED',
      original_start_sec: originalStart,
      original_end_sec: originalEnd,
      expanded_start_sec: originalStart,
      expanded_end_sec: originalEnd,
      expanded_duration_sec: round2(originalDur),
      candidate_text_excerpt: excerpt(utterances, originalStart, originalEnd),
      setup_text_excerpt: null,
      crossed_topic: false,
      duration_limit_hit: false,
      found_setup: true,
    };
  }

  // Backward search: candidate setup utterances strictly BEFORE the window.
  const before = utterances.filter((u) => u.endSec <= originalStart + 0.05 && u.startSec >= originalStart - maxSearchBack);
  if (before.length === 0) {
    return {
      reason_code: 'REJECT_NO_VALID_SETUP',
      original_start_sec: originalStart,
      original_end_sec: originalEnd,
      expanded_start_sec: null,
      expanded_end_sec: null,
      expanded_duration_sec: null,
      candidate_text_excerpt: excerpt(utterances, originalStart, originalEnd),
      setup_text_excerpt: null,
      crossed_topic: false,
      duration_limit_hit: false,
      found_setup: false,
    };
  }

  const byStart = [...before].sort((a, b) => b.startSec - a.startSec); // nearest first
  let chosen: Utterance | null = null;
  let reason: H1ReasonCode = 'REJECT_NO_VALID_SETUP';
  let crossedTopic = false;

  for (const u of byStart) {
    if (chosen) break;
    const candidateStart = u.startSec;
    const newDur = originalEnd - candidateStart;
    if (newDur > hardMax) {
      if (!crossedTopic) reason = 'REJECT_DURATION_LIMIT';
      continue;
    }
    const crossed = wouldCrossTopic(utterances, candidateStart, originalStart);
    if (crossed) {
      reason = 'REJECT_WOULD_CROSS_TOPIC';
      crossedTopic = true;
      continue;
    }
    const text = u.text.trim();
    if (QUESTION_START_RE.test(text)) {
      chosen = u;
      reason = 'EXPAND_TO_QUESTION';
    } else if (REFERENT_RE.test(text)) {
      chosen = u;
      reason = 'EXPAND_TO_REFERENT_SETUP';
    } else if (SENTENCE_END_RE.test(text) || !startsLower(text)) {
      chosen = u;
      reason = 'EXPAND_TO_SENTENCE_START';
    } else if (isTopicSetup(text)) {
      chosen = u;
      reason = 'EXPAND_TO_TOPIC_SETUP';
    }
  }

  if (!chosen) {
    return {
      reason_code: reason,
      original_start_sec: originalStart,
      original_end_sec: originalEnd,
      expanded_start_sec: null,
      expanded_end_sec: null,
      expanded_duration_sec: null,
      candidate_text_excerpt: excerpt(utterances, originalStart, originalEnd),
      setup_text_excerpt: null,
      crossed_topic: crossedTopic,
      duration_limit_hit: reason === 'REJECT_DURATION_LIMIT',
      found_setup: false,
    };
  }

  const expandedStart = chosen.startSec;
  const newDur = round2(originalEnd - expandedStart);
  if (newDur < minDur) {
    return {
      reason_code: 'REJECT_NO_VALID_SETUP',
      original_start_sec: originalStart,
      original_end_sec: originalEnd,
      expanded_start_sec: null,
      expanded_end_sec: null,
      expanded_duration_sec: null,
      candidate_text_excerpt: excerpt(utterances, originalStart, originalEnd),
      setup_text_excerpt: chosen.text.trim().slice(0, 160),
      crossed_topic: false,
      duration_limit_hit: false,
      found_setup: false,
    };
  }

  return {
    reason_code: reason,
    original_start_sec: originalStart,
    original_end_sec: originalEnd,
    expanded_start_sec: round2(expandedStart),
    expanded_end_sec: round2(originalEnd),
    expanded_duration_sec: newDur,
    candidate_text_excerpt: excerpt(utterances, originalStart, originalEnd),
    setup_text_excerpt: chosen.text.trim().slice(0, 160),
    crossed_topic: false,
    duration_limit_hit: false,
    found_setup: true,
  };
}

function isMidContextStart(first: Utterance, utterances: Utterance[], startSec: number): boolean {
  const text = first.text.trim();
  const continues = /^(because|but|so|and|or|then|that|while|if|although|jadi|terus|tapi|karena|kalau|yang)\b/i.test(text);
  const referential = /^(this|that|these|those|it|its|he|she|they|them|the|ini|itu|dia|mereka|gini|gitu)\b/i.test(text);
  const startsMidUtterance = first.startSec < startSec - 0.05;
  const before = utterances.find((u) => u.endSec <= startSec + 0.05 && u.startSec < startSec - 0.05);
  const precedingContinues = before ? /[,，]\s*$/.test(before.text.trim()) || /(and|but|so|because|jadi|terus|tapi|karena)\s*$/i.test(before.text.trim()) : false;
  return continues || referential || startsMidUtterance || precedingContinues;
}

function wouldCrossTopic(utterances: Utterance[], fromSec: number, toSec: number): boolean {
  const inside = utterances.filter((u) => u.endSec > fromSec && u.startSec < toSec);
  if (inside.length === 0) return false;
  // Any topic-transition marker inside the expansion region means we would
  // drag the previous topic into the clip — reject the expansion.
  for (const u of inside) {
    if (TOPIC_TRANSITION_RE.test(u.text.trim())) return true;
  }
  return false;
}

function isTopicSetup(text: string): boolean {
  const t = text.trim();
  return /^(so|okay|alright|now|well|right|oke|nah|jadi)\b/i.test(t);
}

function startsLower(text: string): boolean {
  return /^[a-z]/.test(text.trim());
}

function excerpt(utterances: Utterance[], fromSec: number, toSec: number): string {
  return utterances
    .filter((u) => u.endSec > fromSec && u.startSec < toSec)
    .map((u) => u.text.trim())
    .join(' ')
    .slice(0, 200);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}