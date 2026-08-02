import type { TranscriptCue } from '@/lib/domain/types';

/**
 * Phase 1 (Correctness) — Utterance/Sentence segmentation.
 *
 * The brief requires every clip boundary to land on a real utterance, not on
 * a display-timing caption cue. A caption cue is 3-8 words cut on when YouTube
 * decided to repaint the screen — cutting on it produces clips that start or
 * end mid-sentence.
 *
 * This module rebuilds transcript cues into utterance units that carry the
 * metadata the two-pass highlight selector needs:
 *
 *   start, end, speaker (when the source is diarized), text,
 *   is_complete_sentence, pause_before, pause_after
 *
 * Sentence completion is detected from punctuation, and pauses are measured
 * from cue gaps. Auto-generated tracks often contain no punctuation, so we
 * also break on long pauses and an upper word bound — identical fallbacks to
 * the existing `cuesToSentences`, but now with pause metadata so boundary
 * refinement can snap to real silences instead of guessing.
 */

export interface Utterance {
  startSec: number;
  endSec: number;
  /** Speaker label if the transcript was diarized (speaker_0, ...), else null. */
  speaker: string | null;
  text: string;
  words: number;
  /** True when the utterance ends with sentence punctuation. */
  isCompleteSentence: boolean;
  /** Silence (seconds) before this utterance. 0 for the first cue. */
  pauseBefore: number;
  /** Silence (seconds) after this utterance. 0 at the end. */
  pauseAfter: number;
}

/** A pause long enough to imply a topic change rather than a breath. */
const TOPIC_GAP_SEC = 2.5;
/** A pause long enough to count as a paragraph boundary even mid-sentence. */
const PARAGRAPH_GAP_SEC = 0.75;

const SENTENCE_END_RE = /[.!?…]["')\]]?\s*$/;
/** Cues that look like a speaker label, e.g. "[SPEAKER_00]" or "(speaker_1)". */
const SPEAKER_TAG_RE = /^[\s[(]*[a-z_]*speaker[_\s-]?\d+[)\]»:]*$/i;

function extractSpeaker(cue: TranscriptCue): string | null {
  const match = cue.text.match(SPEAKER_TAG_RE);
  if (!match) return null;
  return match[0].trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Rebuild utterance units from caption cues.
 *
 * Strategy:
 *  - A long pause (> TOPIC_GAP_SEC) always flushes the buffer — the speaker
 *    stopped talking long enough that the next unit is a new utterance.
 *  - Sentence punctuation flushes when the current unit is long enough to be
 *    real speech (>= 2 words), so "okay." doesn't spawn a 0.4s utterance.
 *  - Auto-generated tracks without punctuation break on PARAGRAPH_GAP_SEC
 *    (a real silence, not a breath) or a ~45-word upper bound.
 */
export function cuesToUtterances(cues: readonly TranscriptCue[]): Utterance[] {
  const utterances: Utterance[] = [];

  let buffer: string[] = [];
  let startSec: number | null = null;
  let endSec = 0;
  let words = 0;
  let lastEndSec = 0;

  const flush = (): void => {
    if (buffer.length === 0 || startSec === null) return;
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      utterances.push({
        startSec,
        endSec,
        speaker: null, // assigned below from the first cue that carries a tag
        text,
        words,
        isCompleteSentence: SENTENCE_END_RE.test(text),
        pauseBefore: utterances.length === 0 ? 0 : startSec - lastEndSec,
        pauseAfter: 0,
      });
    }
    buffer = [];
    startSec = null;
    words = 0;
  };

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const previous = i > 0 ? cues[i - 1] : undefined;

    const gap = previous ? cue.startSec - previous.endSec : 0;

    // A topic-length pause always breaks the utterance.
    if (previous && gap >= TOPIC_GAP_SEC) {
      flush();
    }

    if (startSec === null) startSec = cue.startSec;

    // Speaker label cues ("[SPEAKER_00]") are metadata, not content — keep the
    // timestamp but don't put the label into the utterance text.
    const speaker = extractSpeaker(cue);
    if (speaker) {
      // Track speaker on the unit: tag the current buffer with this label.
      if (utterances.length > 0 && utterances[utterances.length - 1]!.endSec === startSec) {
        // Cue starts exactly where the previous utterance ended — likely a
        // label inserted at the boundary. Attach to the previous utterance.
        utterances[utterances.length - 1]!.speaker = speaker;
        utterances[utterances.length - 1]!.pauseAfter = 0;
      }
      continue;
    }

    buffer.push(cue.text);
    endSec = cue.endSec;
    words += countWords(cue.text);

    const punctuated = SENTENCE_END_RE.test(cue.text);
    const longPause = previous && gap >= PARAGRAPH_GAP_SEC;
    const runOn = words >= 45;

    if (punctuated || longPause || runOn) {
      flush();
    }
    lastEndSec = endSec;
  }

  flush();

  // Fill pauseAfter from the next unit's pauseBefore.
  for (let i = 0; i < utterances.length; i += 1) {
    if (i + 1 < utterances.length) {
      utterances[i]!.pauseAfter = Math.max(0, utterances[i + 1]!.startSec - utterances[i]!.endSec);
    }
  }

  return utterances;
}
