import type { MomentSegment, Transcript, TranscriptCue } from '@/lib/domain/types';
import { clamp, round } from '@/lib/scoring/normalize';
import { countMatches, countTerms, LEXICONS, wordCount } from '@/lib/scoring/text';

/**
 * PRD Step 4 - Moment detection.
 *
 * Caption cues are the wrong unit of analysis: they are 3-8 word fragments cut
 * on display timing, not on meaning. Cutting a clip on a cue boundary produces
 * clips that start mid-sentence.
 *
 * So this runs in two stages:
 *
 *   1. Rebuild sentences from cues, so every candidate boundary is a place a
 *      human actually stopped talking.
 *   2. Slide a variable-length window over those sentences to enumerate every
 *      15-90 second candidate, score each cheaply, and keep the best
 *      non-overlapping set.
 *
 * The cheap salience score exists purely to decide what is worth spending an
 * LLM call on. It is a filter, not a judgement - the real scoring happens in
 * Step 5.
 */

export interface Sentence {
  startSec: number;
  endSec: number;
  text: string;
  words: number;
}

/** A pause long enough to imply a topic change rather than a breath. */
const TOPIC_GAP_SEC = 2.5;
const SENTENCE_END = /[.!?]["')\]]?\s*$/;

/**
 * Rebuild sentences from caption cues.
 *
 * Auto-generated tracks often contain no punctuation at all, so we also break
 * on long pauses and on an upper word bound. Without that fallback an ASR
 * transcript would collapse into one enormous sentence.
 */
export function cuesToSentences(cues: readonly TranscriptCue[]): Sentence[] {
  const sentences: Sentence[] = [];

  let buffer: string[] = [];
  let startSec: number | null = null;
  let endSec = 0;
  let words = 0;

  const flush = (): void => {
    if (buffer.length === 0 || startSec === null) return;
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      sentences.push({ startSec, endSec, text, words });
    }
    buffer = [];
    startSec = null;
    words = 0;
  };

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const previous = i > 0 ? cues[i - 1] : undefined;

    if (previous && cue.startSec - previous.endSec >= TOPIC_GAP_SEC) {
      flush();
    }

    if (startSec === null) startSec = cue.startSec;
    buffer.push(cue.text);
    endSec = cue.endSec;
    words += cue.text.split(/\s+/).filter(Boolean).length;

    const punctuated = SENTENCE_END.test(cue.text);
    // ~45 words is roughly 17 seconds of speech - a sane cap for a run-on ASR
    // block with no punctuation to break on.
    if (punctuated || words >= 45) {
      flush();
    }
  }

  flush();
  return sentences;
}

/* -------------------------------------------------------------------------- */
/* Salience pre-filter                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Cheap 0-1 estimate of whether a window is worth scoring properly.
 *
 * Deliberately asymmetric: the penalties (filler, sponsor reads, dangling
 * references) are stronger than the bonuses, because the cost of sending junk to
 * an expensive model is real while the cost of missing a marginal candidate is
 * that we surface one fewer optional clip.
 */
export function computeSalience(text: string, durationSec: number): number {
  const words = wordCount(text);
  if (words === 0) return 0;

  const opening = text.slice(0, 160);

  const hookHits = countMatches(opening, LEXICONS.HOOK_PATTERNS);
  const curiosityHits = countMatches(text, LEXICONS.CURIOSITY_PATTERNS);
  const storyHits = countMatches(text, LEXICONS.STORY_PATTERNS);
  const teachingHits = countMatches(text, LEXICONS.TEACHING_PATTERNS);
  const emotionHits = countTerms(text, LEXICONS.EMOTION_TERMS);
  const shareHits = countMatches(text, LEXICONS.SHAREABILITY_PATTERNS);
  const entertainmentHits = countMatches(text, LEXICONS.ENTERTAINMENT_PATTERNS);
  const controversyHits = countMatches(text, LEXICONS.CONTROVERSY_PATTERNS);

  const fillerCount = countTerms(text, LEXICONS.FILLER_TERMS);
  const fillerRatio = fillerCount / Math.max(1, words / 20);
  const danglingHits = countMatches(opening, LEXICONS.DANGLING_REFERENCE_PATTERNS);
  const promotionalHits = countMatches(text, LEXICONS.PROMOTIONAL_PATTERNS);

  let score = 0.28;

  score += Math.min(0.22, hookHits * 0.12);
  score += Math.min(0.12, curiosityHits * 0.05);
  score += Math.min(0.12, storyHits * 0.045);
  score += Math.min(0.1, teachingHits * 0.05);
  score += Math.min(0.12, emotionHits * 0.035);
  score += Math.min(0.08, shareHits * 0.05);
  score += Math.min(0.06, entertainmentHits * 0.035);
  score += Math.min(0.05, controversyHits * 0.03);

  // Penalties. Sponsor reads are the heaviest: they read as fluent, confident
  // speech full of concrete numbers, so nothing else in this function catches
  // them, and sending them to a paid model is pure waste.
  score -= Math.min(0.3, fillerRatio * 0.18);
  score -= Math.min(0.18, danglingHits * 0.09);
  score -= Math.min(0.34, promotionalHits * 0.2);

  // Speech density: a window that is mostly silence has little to say.
  const wordsPerSecond = words / Math.max(1, durationSec);
  if (wordsPerSecond < 1.4) score -= 0.16;
  if (wordsPerSecond > 4.2) score -= 0.08;

  return clamp(score, 0, 1);
}

/* -------------------------------------------------------------------------- */
/* Window enumeration                                                        */
/* -------------------------------------------------------------------------- */

export interface SegmentationOptions {
  minDurationSec: number;
  maxDurationSec: number;
  targetDurationSec: number;
  /** Upper bound on returned segments. The pipeline's cost ceiling. */
  maxSegments: number;
  /** Drop candidates below this salience before selection. */
  minSalience?: number;
}

interface Candidate {
  startIndex: number;
  endIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  text: string;
  words: number;
  salience: number;
  /** Salience adjusted for how close the window is to the ideal length. */
  rank: number;
}

function enumerateCandidates(
  sentences: readonly Sentence[],
  options: SegmentationOptions,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (let start = 0; start < sentences.length; start += 1) {
    const first = sentences[start]!;
    const parts: string[] = [];
    let words = 0;

    for (let end = start; end < sentences.length; end += 1) {
      const current = sentences[end]!;
      parts.push(current.text);
      words += current.words;

      const durationSec = current.endSec - first.startSec;
      if (durationSec > options.maxDurationSec) break;
      if (durationSec < options.minDurationSec) continue;

      const text = parts.join(' ');
      const salience = computeSalience(text, durationSec);

      // Prefer windows near the target length when salience is comparable, so
      // we do not systematically emit 90 second clips.
      const lengthFit =
        1 -
        Math.min(1, Math.abs(durationSec - options.targetDurationSec) / options.maxDurationSec) *
          0.35;

      candidates.push({
        startIndex: start,
        endIndex: end,
        startSec: first.startSec,
        endSec: current.endSec,
        durationSec,
        text,
        words,
        salience,
        rank: salience * lengthFit,
      });
    }
  }

  return candidates;
}

/**
 * Greedy non-overlapping selection.
 *
 * Overlapping candidates are near-duplicates of one another; surfacing both a
 * 30s and a 55s cut of the same moment would give the editor two rows that mean
 * one decision. Highest rank wins its span.
 */
function selectNonOverlapping(
  candidates: readonly Candidate[],
  maxSegments: number,
): Candidate[] {
  const ordered = [...candidates].sort((a, b) => b.rank - a.rank);
  const taken: Candidate[] = [];

  for (const candidate of ordered) {
    if (taken.length >= maxSegments) break;

    const overlaps = taken.some(
      (chosen) =>
        candidate.startIndex <= chosen.endIndex && candidate.endIndex >= chosen.startIndex,
    );

    if (!overlaps) taken.push(candidate);
  }

  return taken.sort((a, b) => a.startSec - b.startSec);
}

export interface SegmentationResult {
  segments: MomentSegment[];
  sentenceCount: number;
  candidateCount: number;
}

export function detectMoments(
  transcript: Transcript,
  options: SegmentationOptions,
): SegmentationResult {
  const sentences = cuesToSentences(transcript.cues);
  if (sentences.length === 0) {
    return { segments: [], sentenceCount: 0, candidateCount: 0 };
  }

  const minSalience = options.minSalience ?? 0.3;
  const candidates = enumerateCandidates(sentences, options).filter(
    (candidate) => candidate.salience >= minSalience,
  );

  const selected = selectNonOverlapping(candidates, options.maxSegments);

  return {
    sentenceCount: sentences.length,
    candidateCount: candidates.length,
    segments: selected.map((candidate, index) => ({
      index,
      startSec: round(candidate.startSec, 2),
      endSec: round(candidate.endSec, 2),
      durationSec: round(candidate.durationSec, 2),
      text: candidate.text,
      wordCount: candidate.words,
      wordsPerSecond: round(candidate.words / Math.max(1, candidate.durationSec), 2),
      salience: round(candidate.salience, 3),
    })),
  };
}
