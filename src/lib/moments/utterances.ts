import type { TranscriptCue } from '@/lib/domain/types';

/**
 * Phase 1 (Correctness) — Enriched sentence model (brief §5).
 *
 * Rebuilds transcript cues into enriched sentence/utterance units. A caption
 * cue is 3-8 words cut on when the platform decided to repaint the screen —
 * cutting on it produces clips that start or end mid-sentence. This module
 * rebuilds cues into real utterances carrying the metadata the two-pass
 * highlight selector and TopicBoundaryDetector need.
 *
 * PUNCTUATION POLICY (brief §5):
 *   Do NOT split primarily on punctuation, a 45-word cap, or a long audio gap.
 *   Those are FALLBACKS only. The primary unit is a complete idea: we keep
 *   accumulating until there is positive evidence of completion (sentence
 *   punctuation, a paragraph-length pause, or a speaker change), and only then
 *   use the fallbacks (gap / word cap) to bound runaway units on transcripts
 *   that have no punctuation at all.
 */

export interface EnrichedSentence {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  wordCount: number;

  speakerId: string | null;

  pauseBeforeSec: number;
  pauseAfterSec: number;

  isCompleteSentence: boolean;
  startsWithTransition: boolean;
  startsWithQuestion: boolean;
  endsWithQuestion: boolean;

  semanticTopicId: string | null;
  semanticEmbedding?: number[];

  sourceCueStartIndex: number;
  sourceCueEndIndex: number;
}

/** Backward-compatible alias used by earlier modules. */
export type Utterance = EnrichedSentence;

/** A pause long enough to imply a topic change rather than a breath. */
const TOPIC_GAP_SEC = 2.5;
/** A pause long enough to count as a paragraph boundary even mid-sentence. */
const PARAGRAPH_GAP_SEC = 0.75;
/** Upper word bound — fallback only, for punctuation-free tracks. */
const MAX_WORDS = 45;

const SENTENCE_END_RE = /[.!?…]["')\]]?\s*$/;
/** Question ENDING: how/what/why/…, "?", or inverted intonation markers. */
const QUESTION_END_RE = /\?\s*$/;
/** Question STARTERS (Indonesian + English). */
const QUESTION_START_RE =
  /\b(how|what|why|when|where|who|do you|did you|can you|could you|would you|are you|is it|have you|berapa|bagaimana|kenapa|mengapa|apa|siapa|kapan|di mana|apakah|bisa|bisakah)\b/i;
/** Transition phrases (brief §7). These are weak signals, never proof alone. */
const TRANSITION_START_RE =
  /\b(by the way|moving on|another question|speaking of|ngomong-ngomong|omong-omong|selanjutnya|sekarang soal|gue mau nanya|ada topik lain|ada hal lain|balik lagi ke|pertanyaan berikutnya|next up|so next|anyway)\b/i;
/** Cues that look like a speaker label, e.g. "[SPEAKER_00]" or "(speaker_1)". */
const SPEAKER_TAG_RE = /^\s*[\[(]*\s*SPEAKER[\s_-]?\d+\s*[)\]]\s*$/i;

function isSpeakerLabelCue(cue: TranscriptCue): boolean {
  // Only a cue whose TEXT is a pure speaker label is metadata, never content.
  return SPEAKER_TAG_RE.test(cue.text.trim());
}

function extractSpeaker(cue: TranscriptCue): string | null {
  // Phase-2 correctness (F14): the structured speakerId is authoritative —
  // prefer it over heuristically parsing a textual [SPEAKER_n] tag. This is
  // METADATA for content cues; it does not make a content cue a label.
  if (cue.speakerId) {
    return cue.speakerId;
  }
  if (!isSpeakerLabelCue(cue)) return null;
  const match = cue.text.match(SPEAKER_TAG_RE);
  if (!match) return null;
  return match[0].trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function sentenceId(seq: number): string {
  return `s-${seq.toString().padStart(4, '0')}`;
}

/**
 * Rebuild enriched sentence units from caption cues.
 *
 * Completion evidence (in priority order):
 *   1. Speaker change — a new speaker starts a new utterance.
 *   2. Sentence punctuation — the unit ends with .!?…
 *   3. Paragraph pause (>= 0.75s) — real silence after a complete thought.
 *   4. Topic pause (>= 2.5s) — always breaks.
 * Fallback only when none of the above ever fires (punctuation-free track):
 *   5. Word cap (45) — bounds runaway units.
 */
export function cuesToUtterances(cues: readonly TranscriptCue[]): EnrichedSentence[] {
  const utterances: EnrichedSentence[] = [];

  let buffer: string[] = [];
  let startSec: number | null = null;
  let endSec = 0;
  let words = 0;
  let cueStartIndex = -1;
  let cueEndIndex = -1;
  let lastEndSec = 0;
  let currentSpeaker: string | null = null;
  let seq = 0;

  const flush = (): void => {
    if (buffer.length === 0 || startSec === null) return;
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      utterances.push({
        id: sentenceId(seq),
        startSec,
        endSec,
        text,
        wordCount: words,
        speakerId: currentSpeaker,
        pauseBeforeSec: utterances.length === 0 ? 0 : Math.max(0, startSec - lastEndSec),
        pauseAfterSec: 0,
        isCompleteSentence: SENTENCE_END_RE.test(text),
        startsWithTransition: TRANSITION_START_RE.test(text),
        startsWithQuestion: QUESTION_START_RE.test(text),
        endsWithQuestion: QUESTION_END_RE.test(text),
        semanticTopicId: null,
        sourceCueStartIndex: cueStartIndex,
        sourceCueEndIndex: cueEndIndex,
      });
      seq += 1;
    }
    buffer = [];
    startSec = null;
    words = 0;
    cueStartIndex = -1;
    cueEndIndex = -1;
  };

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const previous = i > 0 ? cues[i - 1] : undefined;
    const gap = previous ? cue.startSec - previous.endSec : 0;

    // Speaker label cues ("[SPEAKER_00]") are metadata, not content — they
    // set the speaker for the following content and mark a speaker change.
    // Phase-2 correctness (F14): content cues carry speakerId as metadata and
    // must still be included as content.
    if (isSpeakerLabelCue(cue)) {
      const labelSpeaker = extractSpeaker(cue);
      if (labelSpeaker) {
        if (currentSpeaker !== null && currentSpeaker !== labelSpeaker) {
          // Speaker change: flush the previous unit immediately.
          flush();
        }
        currentSpeaker = labelSpeaker;
      }
      continue;
    }
    const cueSpeaker = extractSpeaker(cue);
    if (cueSpeaker) {
      if (currentSpeaker !== null && currentSpeaker !== cueSpeaker) {
        // Speaker change: flush the previous unit immediately.
        flush();
      }
      currentSpeaker = cueSpeaker;
    }

    // A topic-length pause always breaks the utterance.
    if (previous && gap >= TOPIC_GAP_SEC) {
      flush();
    }

    if (startSec === null) {
      startSec = cue.startSec;
      cueStartIndex = i;
    }
    cueEndIndex = i;

    // Word-cap fallback: if the buffer is ALREADY at the bound, flush BEFORE
    // adding this cue so the split lands between cues, not mid-cue.
    if (words >= MAX_WORDS) {
      flush();
      if (startSec === null) startSec = cue.startSec;
      cueStartIndex = i;
    }

    buffer.push(cue.text);
    endSec = cue.endSec;
    words += countWords(cue.text);

    const punctuated = SENTENCE_END_RE.test(cue.text);
    const longPause = previous && gap >= PARAGRAPH_GAP_SEC;
    const runOn = words >= MAX_WORDS;

    // Completion evidence: punctuation / paragraph pause are primary; the
    // word cap is the fallback for punctuation-free tracks.
    if (punctuated || longPause || runOn) {
      flush();
    }
    lastEndSec = endSec;
  }

  flush();

  // Fill pauseAfterSec from the next unit's pauseBeforeSec.
  for (let i = 0; i < utterances.length; i += 1) {
    if (i + 1 < utterances.length) {
      utterances[i]!.pauseAfterSec = Math.max(0, utterances[i + 1]!.startSec - utterances[i]!.endSec);
    }
  }

  return utterances;
}

export interface TranscriptSlice {
  /** Text of the utterances starting inside [startSec, endSec), joined. */
  text: string;
  wordCount: number;
  wordsPerSecond: number;
  /** Number of speaker changes inside the window (Phase 2 §intelligence). */
  speakerTurns: number;
  /** True when no utterance starts inside the window (empty transcript). */
  empty: boolean;
}

/**
 * Phase 2 (Intelligence correctness) — Re-slice transcript text and derived
 * metrics from the FINAL boundary, not the rough candidate.
 *
 * After boundary repair or refinement moves [start, end], the clip's text,
 * word count, speech density and speaker turns must describe the actual
 * rendered window. Call this with the final boundaries and the full
 * utterance list; never reuse the rough segment's text/wordCount.
 */
export function sliceTranscriptForRange(
  utterances: EnrichedSentence[],
  startSec: number,
  endSec: number,
): TranscriptSlice {
  // Phase-2 correctness (F13): slice at the utterance boundary whose START
  // falls inside the window, instead of grabbing every overlapping utterance
  // whole. Without word-level timings this is the honest word-level slice:
  // trailing fragments of the previous utterance and leading fragments of
  // the next are not counted as full words.
  const inside = utterances.filter(
    (u) => u.startSec >= startSec - 0.05 && u.startSec < endSec,
  );
  const text = inside.map((u) => u.text.trim()).filter(Boolean).join(' ');
  const wordCount = countWords(text);
  const duration = Math.max(0.5, endSec - startSec);

  let speakerTurns = 0;
  let lastSpeaker: string | null = null;
  for (const u of inside) {
    if (u.speakerId && u.speakerId !== lastSpeaker) {
      if (lastSpeaker !== null) {
        speakerTurns += 1;
      }
      lastSpeaker = u.speakerId;
    }
  }

  return {
    text,
    wordCount,
    wordsPerSecond: round2(wordCount / duration),
    speakerTurns,
    empty: inside.length === 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Phase-2 correctness (F15): find the utterance CONTAINING a timestamp, or
 * the closest one ending at/before it. A target inside an utterance must
 * resolve to THAT utterance, not the previous one.
 */
export function utteranceContaining(
  utterances: readonly EnrichedSentence[],
  targetSec: number,
): number {
  for (let i = 0; i < utterances.length; i += 1) {
    const u = utterances[i]!;
    if (targetSec >= u.startSec - 0.05 && targetSec <= u.endSec + 0.05) {
      return i;
    }
  }
  return -1;
}

/**
 * Phase-2 correctness (F15): nearest utterance end at/before target, but if
 * the target lies INSIDE an utterance that utterance wins (previously it
 * returned the PREVIOUS utterance for any in-utterance timestamp).
 */
export function utteranceAtOrBefore(
  utterances: readonly EnrichedSentence[],
  targetSec: number,
): number {
  const containing = utteranceContaining(utterances, targetSec);
  if (containing >= 0) {
    return containing;
  }
  let best = -1;
  for (let i = 0; i < utterances.length; i += 1) {
    if (utterances[i]!.endSec <= targetSec + 0.05) {
      best = i;
    } else {
      break;
    }
  }
  return best;
}
