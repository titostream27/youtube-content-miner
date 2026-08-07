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
  /**
   * Brief v5 M-03: canonical per-word timing carried from the transcript
   * cues into the semantic utterance. Present when the vendor provided
   * words; sliceTranscriptForRange uses these for TRUE word-level slicing.
   */
  words?: { text: string; startSec: number; endSec: number }[];
  /**
   * Brief v10 C09 (V10-M02): honest timing provenance. A cue/utterance is
   * word-timed ONLY when its timed tokens reasonably cover the source text
   * (>=95% token coverage after normalization). These fields let slicing
   * preserve untimed speech instead of silently dropping it.
   */
  sourceTokenCount?: number;
  timedTokenCount?: number;
  wordTimingCompleteness?: 'full' | 'partial' | 'none';
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
  /^(how|what|why|when|where|who|do you|did you|can you|could you|would you|are you|is it|have you|berapa|bagaimana|kenapa|mengapa|apa|siapa|kapan|di mana|apakah|bisa|bisakah)\b/i;
/** Transition phrases (brief §7). These are weak signals, never proof alone.
 * Brief v4 F12: anchored to the START of the utterance — a mid-sentence
 * 'anyway'/'by the way' must not set startsWithTransition. */
const TRANSITION_START_RE =
  /^(by the way|moving on|another question|speaking of|ngomong-ngomong|omong-omong|selanjutnya|sekarang soal|gue mau nanya|ada topik lain|ada hal lain|balik lagi ke|pertanyaan berikutnya|next up|so next|anyway)\b/i;
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
  let wordBuffer: { text: string; startSec: number; endSec: number }[] = [];
  let startSec: number | null = null;
  let endSec = 0;
  let words = 0;
  let cueStartIndex = -1;
  let cueEndIndex = -1;
  let lastUtteranceEnd = 0;
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
        // Brief v5 M-03: propagate canonical word timing into the utterance.
        words: wordBuffer.length > 0 ? [...wordBuffer] : undefined,
        pauseBeforeSec: utterances.length === 0 ? 0 : Math.max(0, startSec - lastUtteranceEnd),
        pauseAfterSec: 0,
        isCompleteSentence: SENTENCE_END_RE.test(text),
        startsWithTransition: TRANSITION_START_RE.test(text),
        startsWithQuestion: QUESTION_START_RE.test(text),
        endsWithQuestion: QUESTION_END_RE.test(text),
        semanticTopicId: null,
        sourceCueStartIndex: cueStartIndex,
        sourceCueEndIndex: cueEndIndex,
      });
      // Track the END of the utterance just flushed so the NEXT utterance's
      // pauseBeforeSec measures the real gap between utterances (not the end
      // of the current cue, which would be the same as its start).
      lastUtteranceEnd = endSec;
      seq += 1;
    }
    buffer = [];
    wordBuffer = [];
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

    // Brief v4 F11: a paragraph-length pause (0.75s) also breaks the
    // utterance — and must FLUSH BEFORE adding this cue, so the cue after the
    // pause STARTS a fresh utterance instead of being merged into the
    // previous one (which happens when the flush runs after buffer.push).
    if (previous && gap >= PARAGRAPH_GAP_SEC) {
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
    // Brief v5 M-03: carry canonical per-word timing into the utterance.
    if (Array.isArray(cue.words) && cue.words.length > 0) {
      wordBuffer.push(...cue.words.map((w) => ({
        text: w.text,
        startSec: w.startSec,
        endSec: w.endSec,
      })));
    }
    endSec = cue.endSec;
    words += countWords(cue.text);

    // Brief v4 F11: paragraph pause is handled above (pre-push flush), so the
    // after-push completion closure covers punctuation + word cap only.
    const punctuated = SENTENCE_END_RE.test(cue.text);
    const runOn = words >= MAX_WORDS;

    if (punctuated || runOn) {
      flush();
    }
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
  /**
   * Hardening v3 C4 (#17): how precise the slice is.
   * - 'word'      — built from word-level timing (canonical, exact).
   * - 'hybrid'    — timed words where available + untimed text for gaps.
   * - 'cue'       — cue-level timing only (intersected/clamped at cue start).
   * - 'utterance' — approximate; derived without reliable per-cue timing.
   */
  timingPrecision: 'word' | 'hybrid' | 'cue' | 'utterance';
  /** True when the slice is approximate (hybrid/cue/utterance precision). */
  sliceApproximate: boolean;
  /** Brief v6 5.3 (M02): fraction of the window covered by word timing (0..1). */
  wordTimingCoverage: number;
  /** Brief v6 5.3 (M02): untimed intervals inside the window (diagnostics). */
  uncoveredIntervalsSec?: { startSec: number; endSec: number }[];
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
/**
 * Brief v10 C09 (V10-M02): classify an utterance's word-timing completeness.
 *
 * full    — timed tokens reasonably cover the source (>=95% token coverage).
 * partial — some tokens timed, but untimed source text must be preserved.
 * none    — no word timing at all.
 *
 * The token coverage is computed on normalized tokens (lowercased), comparing
 * the timed-words set against the source-text set. When the caller has already
 * recorded explicit fields (sourceTokenCount / timedTokenCount /
 * wordTimingCompleteness) those win; otherwise we infer from words.
 */
function classifyTimingCompleteness(u: EnrichedSentence): 'full' | 'partial' | 'none' {
  const ws = (u as { words?: { text: string; startSec: number; endSec: number }[] }).words;
  if (!Array.isArray(ws) || ws.length === 0) {
    return 'none';
  }
  if (u.wordTimingCompleteness) {
    return u.wordTimingCompleteness;
  }
  const srcCount = u.sourceTokenCount ?? countWords(u.text);
  const timedCount = u.timedTokenCount ?? ws.length;
  if (srcCount <= 0) {
    return 'none';
  }
  const coverage = timedCount / srcCount;
  return coverage >= 0.95 ? 'full' : 'partial';
}


export function sliceTranscriptForRange(
  utterances: EnrichedSentence[],
  startSec: number,
  endSec: number,
): TranscriptSlice {
  // Phase-2 correctness (F13): slice at the utterance boundary whose START
  // falls inside the window; for word-level slicing we also need utterances
  // that OVERLAP the window (started before) so their words can be clipped.
  const inside = utterances.filter(
    (u) => u.startSec >= startSec - 0.05 && u.startSec < endSec,
  );
  const overlapping = utterances.filter(
    (u) => u.endSec > startSec && u.startSec < endSec,
  );

  // Brief v6 5.3 (M02): explicit timing coverage + hybrid slicing.
  // Compute the union of timed (word) intervals and untimed overlap.
  const wordsInside: { text: string; startSec: number; endSec: number }[] = [];
  const timedIntervals: { startSec: number; endSec: number }[] = [];
  let timedTotal = 0;
  for (const u of overlapping) {
    const ws = (u as { words?: { text: string; startSec: number; endSec: number }[] }).words;
    if (Array.isArray(ws) && ws.length > 0) {
      const clipped: { startSec: number; endSec: number }[] = [];
      for (const w of ws) {
        if (w.endSec > startSec && w.startSec < endSec) {
          wordsInside.push({
            text: w.text,
            startSec: Math.max(w.startSec, startSec),
            endSec: Math.min(w.endSec, endSec),
          });
          clipped.push({ startSec: Math.max(w.startSec, startSec), endSec: Math.min(w.endSec, endSec) });
        }
      }
      timedIntervals.push(...clipped);
    }
  }
  // Total timed duration inside the window (union of intervals).
  timedIntervals.sort((a, b) => a.startSec - b.startSec);
  let mergedTimed = 0;
  let cursor = startSec;
  for (const iv of timedIntervals) {
    if (iv.endSec <= cursor) continue;
    const s = Math.max(iv.startSec, cursor);
    mergedTimed += iv.endSec - s;
    cursor = Math.max(cursor, iv.endSec);
  }
  // Brief v7 M03: coverage is the fraction of ACTIVE SPEECH that is word
  // timed, NOT words / full wall-clock. The denominator is the union of all
  // spoken spans (timed words + untimed utterance spans), so natural pauses
  // and inter-word gaps do not dilute it. A fully word-timed clip with
  // pauses must still score ~1.0.
  // Brief v10 C09 (V10-M02): an utterance is only "covered" when its word
  // timing is FULL (>=95% token coverage). A PARTIALLY timed utterance's
  // untimed tail must count as uncovered speech too — otherwise coverage is
  // overstated and untimed words are silently treated as covered.
  const untimedOverlap = overlapping.filter(
    (u) => classifyTimingCompleteness(u) !== 'full',
  );
  // Brief v7 M03: only utterances carrying speech text count toward active
  // speech — empty pause markers must not dilute coverage.
  const untimedSpans = untimedOverlap
    .filter((u) => u.text.trim().length > 0)
    .map((u) => ({
      startSec: Math.max(u.startSec, startSec),
      endSec: Math.min(u.endSec, endSec),
    }));
  const spokenSpans = [...timedIntervals, ...untimedSpans]
    .filter((iv) => iv.endSec > iv.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  let activeSpeech = 0;
  let spCur = startSec;
  for (const iv of spokenSpans) {
    if (iv.endSec <= spCur) continue;
    const s = Math.max(iv.startSec, spCur);
    activeSpeech += iv.endSec - s;
    spCur = Math.max(spCur, iv.endSec);
  }
  const windowDuration = Math.max(0.5, endSec - startSec);
  // coverage >= 0.95 means (almost) every spoken second is word-timed.
  const coverage =
    activeSpeech >= 0.5 ? Math.min(1, mergedTimed / activeSpeech) : 0;

  // Uncovered intervals = untimed utterance spans clipped to the window.
  const uncoveredIntervalsSec = untimedOverlap
    .map((u) => ({ startSec: Math.max(u.startSec, startSec), endSec: Math.min(u.endSec, endSec) }))
    .filter((iv) => iv.endSec > iv.startSec);

  const wordLevelText = wordsInside.map((w) => w.text).join(' ');
  const wordLevelCount = wordsInside.length;

  // Decide precision honestly:
  //   coverage >= 0.95 -> 'word' (exact)
  //   coverage > 0     -> 'hybrid' (timed words + untimed text, approximate)
  //   coverage == 0    -> 'utterance' (no word timing at all)
  let text: string;
  let wordCount: number;
  let timingPrecision: 'word' | 'hybrid' | 'utterance';
  let sliceApproximate: boolean;
  if (coverage >= 0.95 && wordLevelText) {
    timingPrecision = 'word';
    sliceApproximate = false;
    text = wordLevelText;
    wordCount = wordLevelCount;
  } else if (coverage > 0) {
    timingPrecision = 'hybrid';
    sliceApproximate = true;
    // Brief v7 M04: build hybrid text CHRONOLOGICALLY. Merge per-utterance
    // timed word spans and untimed utterance text ordered by (startSec,
    // endSec), so A(timed)->B(untimed)->C(timed) yields "A B C", never
    // "A C B". Timed words for an utterance already carry that utterance's
    // text, so we don't double-count.
    const segments: { at: number; i: number; text: string }[] = [];
    let order = 0;
    for (const u of overlapping) {
      // Brief v10 C09 (V10-M02): classify completeness. A 'partial' utterance
      // must preserve its FULL source text (never only the timed-word subset),
      // otherwise untimed words silently disappear from the candidate text.
      const completeness = classifyTimingCompleteness(u);
      if (completeness === 'full') {
        const ws = (u as { words?: { text: string; startSec: number; endSec: number }[] }).words!;
        const chunk = ws
          .filter((w) => w.endSec > startSec && w.startSec < endSec)
          .map((w) => w.text)
          .join(' ');
        if (chunk) {
          segments.push({ at: u.startSec, i: order++, text: chunk });
        }
      } else {
        // 'partial' or 'none': keep the FULL source utterance text once so no
        // in-window speech is dropped. Precision degrades honestly (hybrid /
        // utterance) while content stays complete.
        const t = u.text.trim();
        if (t) {
          segments.push({ at: u.startSec, i: order++, text: t });
        }
      }
    }
    segments.sort((a, b) => a.at - b.at || a.i - b.i);
    text = segments
      .map((s) => s.text)
      .filter(Boolean)
      .join(' ')
      .trim();
    wordCount = countWords(text);
  } else {
    // No word timing — slice at utterance level (NOT cue level).
    timingPrecision = 'utterance';
    sliceApproximate = true;
    text = inside.map((u) => u.text.trim()).filter(Boolean).join(' ');
    wordCount = countWords(text);
  }
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
    empty: inside.length === 0 && wordsInside.length === 0,
    timingPrecision,
    sliceApproximate,
    // Brief v6 5.3 (M02): honest coverage + diagnostics.
    wordTimingCoverage: round2(coverage),
    uncoveredIntervalsSec,
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
 * Phase-2 correctness (F15): nearest utterance STARTING at/after target.
 * Complementary to utteranceAtOrBefore — lets callers split a timestamp
 * lookup into containing / before / after without duplicating logic.
 */
export function utteranceAfter(
  utterances: readonly EnrichedSentence[],
  targetSec: number,
): number {
  for (let i = 0; i < utterances.length; i += 1) {
    if (utterances[i]!.startSec >= targetSec - 0.05) {
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
