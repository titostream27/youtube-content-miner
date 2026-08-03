import type { Utterance } from '@/lib/moments/utterances';

/**
 * Phase 1 (Correctness) — Topic boundary detector + ending classification.
 *
 * The brief (BAGIAN A §5-6) requires clips to end on a complete idea and NOT
 * include the opening of the next topic. This module provides the local,
 * deterministic half of that: it looks at the utterances around a candidate
 * ending and decides whether a topic change happened, what kind of ending the
 * candidate has, and where the next topic starts.
 *
 * The LLM boundary-refinement agent (two-pass, §3) supplies the semantic
 * judgement; this detector supplies the guard that is cheap, deterministic and
 * always run — so a model failure degrades to "conservative boundary" instead
 * of "contaminated clip".
 */

export type EndingType =
  | 'PAYOFF'
  | 'CONCLUSION'
  | 'PUNCHLINE'
  | 'ANSWER_COMPLETE'
  | 'TOPIC_TRANSITION'
  | 'QUESTION_START'
  | 'INCOMPLETE_SENTENCE'
  | 'FILLER'
  | 'UNKNOWN';

export interface TopicBoundary {
  /** True if a topic change was detected around this point. */
  nextTopicDetected: boolean;
  /** Where the next topic starts (sec), or null. */
  nextTopicStart: number | null;
  /** 0..1 estimate of how much of the following topic leaked into the clip. */
  contamination: number;
}

export interface EndingAnalysis {
  endingType: EndingType;
  /** 0..1 confidence that this is a complete, acceptable ending. */
  endingConfidence: number;
  endingComplete: boolean;
}

export interface EndCandidate {
  /** Candidate ending time in seconds. */
  time: number;
  type: EndingType;
  score: number;
}

/** Transition phrases that often signal a new topic. Not sufficient alone. */
const TRANSITION_PHRASES: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(ngomong-ngomong|omong-omong)\b/i, label: 'indonesian_by_the_way' },
  { pattern: /\bby the way\b/i, label: 'by_the_way' },
  { pattern: /\bselanjutnya\b/i, label: 'indonesian_next' },
  { pattern: /\bbalik lagi ke\b/i, label: 'indonesian_back_to' },
  { pattern: /\bsekarang soal\b/i, label: 'indonesian_now_about' },
  { pattern: /\bpertanyaan berikutnya\b/i, label: 'indonesian_next_question' },
  { pattern: /\bgue mau nanya\b/i, label: 'indonesian_ask' },
  { pattern: /\bada hal lain\b/i, label: 'indonesian_other_thing' },
  { pattern: /\btopik lain\b/i, label: 'indonesian_other_topic' },
  { pattern: /\bmoving on\b|\banyway\b|\bso next\b|\bnext up\b/i, label: 'english_next' },
  { pattern: /\b(sekarang|selanjutnya|berikutnya),?\s+(bagaimana|apa|kenapa|kapan)\b/i, label: 'indonesian_question' },
  { pattern: /\b(how about|what about|now what|so tell me|i want to ask)\b/i, label: 'english_question' },
];

/** Question starters that indicate a NEW question rather than the current answer. */
const QUESTION_STARTERS = [
  /\b(how|what|why|when|where|who|do you|did you|can you|could you|would you|are you|is it|have you)\b/i,
  /\b(berapa|bagaimana|kenapa|mengapa|apa|siapa|kapan|di mana|apakah)\b/i,
];

const FILLER_RE = /\b(uh|um|erm|ah|eh|you know|like|i mean|kind of|sort of)\b/i;

/** Incomplete if it ends with a dangling conjunction/preposition/article AND
 * the text has no sentence punctuation anywhere — a strong truncation signal
 * on ASR transcripts. A normal spoken sentence that ends with a common word
 * ("the plan", "so we left") must NOT be flagged incomplete; only genuine
 * dangling endings (article/conjunction with nothing after) are incomplete. */
const INCOMPLETE_END_RE = /\b(the|a|an|and|but|or|because|so|if|with|of|to|in|on|at|for)\s*$/i;

const TOPIC_CHANGE_THRESHOLD = 0.58;

/** Rough lexical overlap — higher means more similar (same topic). */
function lexicalSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean));
  const wa = tokenize(a);
  const wb = tokenize(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) {
    if (wb.has(w)) common += 1;
  }
  return common / Math.max(1, Math.min(wa.size, wb.size));
}

function hasTransitionPhrase(text: string): boolean {
  return TRANSITION_PHRASES.some(({ pattern }) => pattern.test(text));
}

function isQuestionStart(text: string): boolean {
  // Question starters must appear at the START of the utterance (first or
  // second word). A "why" buried mid-sentence ("so that is why it failed")
  // is narrative, not a question.
  const head = text.trim().split(/\s+/).slice(0, 2).join(' ');
  return QUESTION_STARTERS.some((re) => re.test(head));
}

function isIncomplete(text: string): boolean {
  // Genuine truncation: ends with a dangling word AND the whole unit contains
  // no sentence-final punctuation (ASR dropped it). If the utterance has any
  // punctuation, treat the end as deliberate even when the last word is common.
  const trimmed = text.trim();
  if (!INCOMPLETE_END_RE.test(trimmed)) return false;
  return !SENTENCE_END_RE.test(trimmed) && !/[.!?…]/.test(trimmed);
}

function isFiller(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= 8 && FILLER_RE.test(text) && !SENTENCE_END_RE.test(text.trim());
}

const SENTENCE_END_RE = /[.!?…]["')\]]?\s*$/;

/** Named-entity approximation: capitalized tokens (English names/places) or
 * proper nouns in Indonesian (also capitalized at sentence start, so this is
 * a weak signal combined with others, never proof alone). */
function namedEntities(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,})\b/g)) {
    out.add(m[1]!.toLowerCase());
  }
  return out;
}

/** Subject approximation: first-person pronouns vs. third-person vs. "you"
 * vs. impersonal — a shift suggests a new focus (brief §7). */
function subjectClass(text: string): string {
  const t = text.toLowerCase();
  if (/\b(i|we|my|our|saya|kami|kita|gue|gw)\b/.test(t)) return 'first';
  if (/\b(you|your|kamu|anda|lu|lo)\b/.test(t)) return 'second';
  if (/\b(he|she|they|his|her|their|dia|mereka)\b/.test(t)) return 'third';
  return 'impersonal';
}

/** Intent approximation: question words, imperatives, opinion markers. */
function intentClass(text: string): string {
  const t = text.toLowerCase();
  if (isQuestionStart(t)) return 'question';
  if (/\b(remember|imagine|look|wait|so|jadi|ingat|bayangkan|tunggu)\b/.test(t)) return 'engage';
  if (/\b(i think|i believe|in my opinion|menurut saya|menurut gue|sebenarnya|faktanya)\b/.test(t)) return 'opinion';
  return 'statement';
}

/**
 * Classify the ending at `endUtterance` (the utterance whose end is the
 * candidate clip end).
 *
 * @param endUtterance the last utterance included in the clip
 * @param nextUtterance the utterance right after the candidate end (may be null)
 * @param following the utterances after `nextUtterance` for context
 */
export function classifyEnding(
  endUtterance: Utterance,
  nextUtterance: Utterance | null,
  _following: Utterance[] = [],
): EndingAnalysis {
  const text = endUtterance.text.trim();
  const nextText = nextUtterance?.text.trim() ?? '';

  // The clip cannot end mid-sentence. Only flag when the utterance genuinely
  // dangles (ends with article/conjunction AND has no punctuation anywhere).
  // ASR transcripts routinely omit final punctuation, so "no period" alone
  // must NOT be treated as incomplete — that rejected every real conclusion.
  if (isIncomplete(text)) {
    return { endingType: 'INCOMPLETE_SENTENCE', endingConfidence: 0.3, endingComplete: false };
  }

  if (isFiller(text)) {
    return { endingType: 'FILLER', endingConfidence: 0.35, endingComplete: false };
  }

  // If the next utterance is a question or a transition phrase, the ending was
  // probably a topic transition, not a real conclusion. BUT: a transition
  // phrase is not sufficient on its own (brief §5) — if the current utterance
  // ends with clear sentence punctuation, treat it as a complete ending even
  // when the next speaker changes subject.
  if (nextUtterance && (isQuestionStart(nextText) || hasTransitionPhrase(nextText))) {
    const currentEndsClean = SENTENCE_END_RE.test(text) || endUtterance.pauseAfterSec >= 0.45;
    if (currentEndsClean) {
      if (/^(so|and so|therefore|in the end|at the end of the day|that's why|itulah|jadi|kesimpulannya)\b/i.test(text)) {
        return { endingType: 'CONCLUSION', endingConfidence: 0.88, endingComplete: true };
      }
      return { endingType: 'ANSWER_COMPLETE', endingConfidence: 0.82, endingComplete: true };
    }
    return { endingType: 'TOPIC_TRANSITION', endingConfidence: 0.6, endingComplete: false };
  }

  // A question STARTING the utterance is a bad ending regardless of the final
  // punctuation — "What do you think about that?" is a question, not a
  // punchline. Check BEFORE the punctuation branch.
  if (isQuestionStart(text)) {
    return { endingType: 'QUESTION_START', endingConfidence: 0.5, endingComplete: false };
  }

  // Pause-after matters: a long silence after a complete sentence is a clean end.
  const longPause = nextUtterance !== null && endUtterance.pauseAfterSec >= 0.5;

  if (SENTENCE_END_RE.test(text)) {
    // PUNCHLINE: short, punchy, possibly exclamation.
    if (/[!?…]$/.test(text.trim()) && endUtterance.wordCount <= 14) {
      return { endingType: 'PUNCHLINE', endingConfidence: 0.82 + (longPause ? 0.08 : 0), endingComplete: true };
    }
    // ANSWER_COMPLETE: ends with a period and reads like a direct answer.
    if (nextUtterance && endUtterance.pauseAfterSec >= 0.3) {
      return { endingType: 'ANSWER_COMPLETE', endingConfidence: 0.8, endingComplete: true };
    }
    return { endingType: 'CONCLUSION', endingConfidence: 0.78, endingComplete: true };
  }

  // Punctuation-free transcript: a short unit with a long pause reads as a
  // complete answer even without a period.
  if (endUtterance.pauseAfterSec >= 0.5 && endUtterance.wordCount >= 2) {
    return { endingType: 'ANSWER_COMPLETE', endingConfidence: 0.72, endingComplete: true };
  }

  return { endingType: 'UNKNOWN', endingConfidence: 0.45, endingComplete: false };
}

/**
 * Detect a topic boundary after `endUtterance`.
 *
 * Uses: transition phrases, question starters, lexical similarity drop,
 * speaker change, long pause, and incomplete sentence. Returns the detected
 * next-topic start and a 0..1 contamination estimate (how much of the next
 * topic would leak into the clip if it ended here).
 */
export function detectTopicBoundary(
  endUtterance: Utterance,
  nextUtterance: Utterance | null,
  following: Utterance[] = [],
  lookaheadSec = 12,
): TopicBoundary {
  if (!nextUtterance) {
    return { nextTopicDetected: false, nextTopicStart: null, contamination: 0 };
  }

  const similarity = lexicalSimilarity(endUtterance.text, nextUtterance.text);
  const transition = hasTransitionPhrase(nextUtterance.text);
  const question = isQuestionStart(nextUtterance.text);
  const speakerChanged = nextUtterance.speakerId !== null && endUtterance.speakerId !== null &&
    nextUtterance.speakerId !== endUtterance.speakerId;
  const longPause = nextUtterance.pauseBeforeSec >= 0.6;
  const nextIncomplete = isIncomplete(nextUtterance.text);
  // Entity / subject / intent change (brief §7).
  const entityDiff = namedEntities(nextUtterance.text).size > 0 &&
    [...namedEntities(nextUtterance.text)].every((e) => !namedEntities(endUtterance.text).has(e));
  const subjectChanged = subjectClass(nextUtterance.text) !== subjectClass(endUtterance.text);
  const intentChanged = intentClass(nextUtterance.text) !== intentClass(endUtterance.text);

  let boundaryScore = 0;

  // A transition phrase is a strong signal but not sufficient (the brief warns
  // against treating every "by the way" as a topic change).
  if (transition) boundaryScore += 0.6;
  if (question) boundaryScore += 0.55;
  if (similarity < 0.2) boundaryScore += 0.5;
  if (similarity < 0.12) boundaryScore += 0.25;
  if (speakerChanged) boundaryScore += 0.35;
  if (longPause) boundaryScore += 0.4;
  if (nextIncomplete) boundaryScore += 0.3;
  if (entityDiff) boundaryScore += 0.3;
  if (subjectChanged) boundaryScore += 0.2;
  if (intentChanged) boundaryScore += 0.2;

  const detected = boundaryScore >= TOPIC_CHANGE_THRESHOLD;

  // Look ahead for the next topic's actual start — the first utterance in the
  // window that looks like a fresh topic (question / transition / low sim).
  let nextTopicStart: number | null = null;
  let contamination = 0;

  if (detected) {
    // Start of the topic change is the next utterance's start, clamped by the
    // lookahead window (the brief: HIGHLIGHT_NEXT_TOPIC_LOOKAHEAD_S=12).
    const windowEnd = endUtterance.endSec + lookaheadSec;
    const candidates = [nextUtterance, ...following].filter(
      (u) => u.startSec <= windowEnd,
    );
    const firstFresh = candidates.find(
      (u) =>
        u === nextUtterance ||
        isQuestionStart(u.text) ||
        hasTransitionPhrase(u.text) ||
        lexicalSimilarity(endUtterance.text, u.text) < 0.2,
    );
    nextTopicStart = firstFresh?.startSec ?? nextUtterance.startSec;
    contamination = Math.min(1, (nextTopicStart - endUtterance.endSec) / Math.max(1, lookaheadSec));
    if (contamination < 0) contamination = 0;
  }

  return { nextTopicDetected: detected, nextTopicStart, contamination };
}

/** Pick the best ending among candidate times, preferring clean complete types. */
export function selectBestEnding(candidates: EndCandidate[]): EndCandidate | null {
  if (candidates.length === 0) return null;

  const PREFERRED = new Set<EndingType>(['PAYOFF', 'CONCLUSION', 'PUNCHLINE', 'ANSWER_COMPLETE']);
  const REJECTED = new Set<EndingType>([
    'TOPIC_TRANSITION',
    'QUESTION_START',
    'INCOMPLETE_SENTENCE',
  ]);

  const ranked = [...candidates].sort((a, b) => {
    const apref = PREFERRED.has(a.type) ? 1 : REJECTED.has(a.type) ? -1 : 0;
    const bpref = PREFERRED.has(b.type) ? 1 : REJECTED.has(b.type) ? -1 : 0;
    if (apref !== bpref) return bpref - apref;
    return b.score - a.score;
  });

  return ranked[0] ?? null;
}
