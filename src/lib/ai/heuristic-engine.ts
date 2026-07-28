import { CLIP_CATEGORIES, DEFAULT_CATEGORY, type ClipCategory } from '@/lib/domain/categories';
import type { ClipDimensionScores, ClipJudgement, MomentSegment } from '@/lib/domain/types';
import { clamp, piecewise, round } from '@/lib/scoring/normalize';
import { countMatches, countTerms, LEXICONS, wordCount } from '@/lib/scoring/text';

/**
 * Deterministic scoring engine.
 *
 * This is the fallback when no LLM provider is configured, when a provider is
 * down, or when a scoring batch fails. It is not a stub: it scores all ten
 * dimensions from lexical evidence, assigns a category, and writes usable clip
 * metadata.
 *
 * Two reasons it exists rather than the pipeline simply failing:
 *
 *  1. The whole product can be evaluated - cloned, run, reviewed - with no API
 *     keys and no spend.
 *  2. A provider outage degrades quality instead of losing an entire archive
 *     mining run partway through.
 *
 * What it cannot do is understand meaning. It detects the SHAPE of a good
 * moment, not whether the moment is actually insightful. That gap is why
 * `confidence.ts` caps heuristic confidence well below LLM confidence - the
 * scores stay useful for ranking without ever claiming to be judgements.
 */

const CATEGORY_KEYWORDS: Record<ClipCategory, string[]> = {
  Business: ['company', 'business', 'revenue', 'customer', 'market', 'margin', 'operations', 'vendor', 'b2b'],
  Finance: ['money', 'invest', 'investor', 'compound', 'interest', 'portfolio', 'valuation', 'salary', 'income', 'equity', 'rent', 'mortgage', 'dollars', 'capital'],
  Marketing: ['marketing', 'brand', 'positioning', 'audience', 'content', 'ads', 'campaign', 'funnel', 'copy', 'pricing', 'share'],
  Startup: ['startup', 'founder', 'seed', 'raise', 'pivot', 'product market', 'runway', 'ship', 'launch', 'venture', 'starting a company', 'investor meeting', 'payroll'],
  Motivation: ['keep going', 'gave up', 'never quit', 'push through', 'believe', 'dream', 'grind', 'motivated'],
  Funny: ['laughter', 'laughs', 'funny', 'joke', 'ridiculous', 'hilarious', 'haha'],
  Story: ['remember', 'one day', 'years ago', 'walked', 'called', 'happened', 'the first time', 'my father', 'my son', 'she told me', 'he said'],
  Psychology: ['brain', 'behaviour', 'behavior', 'study', 'cognitive', 'bias', 'emotion', 'trauma', 'therapy', 'shame', 'boundary'],
  Mindset: ['mindset', 'discipline', 'identity', 'belief', 'perspective', 'resilient', 'resilience', 'fear'],
  Leadership: ['team', 'manager', 'management', 'hire', 'hiring', 'fire', 'fired', 'leader', 'leadership', 'veto', 'report'],
  Health: ['sleep', 'health', 'doctor', 'patient', 'exercise', 'diet', 'nutrition', 'clinic', 'body', 'caffeine', 'burnout'],
  Productivity: ['productivity', 'focus', 'routine', 'habit', 'commitment', 'calendar', 'workflow', 'deep work', 'inbox'],
  Controversial: ['disagree', 'unpopular', 'wrong', 'myth', 'overrated', 'nonsense', 'hot take', 'tired of pretending'],
  Educational: ['framework', 'principle', 'how to', 'the way to', 'lesson', 'rule', 'step', 'formula', 'explain'],
  News: ['regulator', 'regulation', 'policy', 'last quarter', 'announced', 'guidance', 'election', 'court', 'lawsuit'],
  Inspirational: ['inspire', 'hope', 'purpose', 'meaning', 'legacy', 'grateful', 'proud'],
};

/** Rough density normaliser: hits per ~100 words. */
function density(hits: number, words: number): number {
  if (words === 0) return 0;
  return (hits / words) * 100;
}

/**
 * Podcasts speak numbers rather than writing them, so `\d` alone finds almost
 * none of the specificity that makes a story concrete.
 */
const SPELLED_NUMBERS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty',
  'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion',
  'first', 'second', 'third', 'ninth',
];

function countNumericSpecifics(text: string): number {
  const digits = (text.match(/\b\d[\d,.]*\b/g) ?? []).length;
  const spelled = countTerms(text.toLowerCase(), SPELLED_NUMBERS);
  return digits + spelled;
}

/**
 * Calibration note.
 *
 * These baselines are set so the heuristic engine's output lands on the SAME
 * 0-100 scale as an LLM's, because the Step 7 thresholds are absolute - 95 has
 * to mean the same thing regardless of which engine produced it. A filler
 * segment must land in the 20s-40s and a well-shaped moment in the 80s, or the
 * tiers stop partitioning anything.
 *
 * The honesty comes from confidence rather than from deflated scores: heuristic
 * confidence is capped at 82 in `confidence.ts`, so these scores are trusted for
 * ranking without ever being presented as understanding.
 */
function scoreHook(text: string): number {
  const opening = text.slice(0, 180);
  const hookHits = countMatches(opening, LEXICONS.HOOK_PATTERNS);
  const dangling = countMatches(opening, LEXICONS.DANGLING_REFERENCE_PATTERNS);
  const opensWithQuestion = /^[^.?!]{0,120}\?/.test(text);
  const opensWithNumber = /^\s*(?:there (?:are|is)\s+)?(?:one|two|three|four|five|\d+)\b/i.test(text);

  let score = 46;
  score += Math.min(46, hookHits * 24);
  score += opensWithQuestion ? 9 : 0;
  score += opensWithNumber ? 7 : 0;
  score -= Math.min(34, dangling * 24);

  // A hook cannot survive being buried: penalise very long first sentences.
  const firstSentenceWords = (text.split(/[.!?]/)[0] ?? '').split(/\s+/).filter(Boolean).length;
  if (firstSentenceWords > 40) score -= 8;

  // Filler in the opening is fatal for a hook specifically.
  const openingFiller = countTerms(opening, LEXICONS.FILLER_TERMS);
  score -= Math.min(26, openingFiller * 13);

  return clamp(score);
}

function scoreCuriosity(text: string, words: number): number {
  const hits = countMatches(text, LEXICONS.CURIOSITY_PATTERNS);
  const questionMarks = (text.match(/\?/g) ?? []).length;

  // Kept deliberately harder to max out than the other drivers: curiosity
  // markers are the cheapest signal to trip accidentally, and under the top-2
  // driver model an inflated dimension would carry mediocre clips.
  let score = 46;
  score += Math.min(30, hits * 12);
  score += Math.min(10, questionMarks * 4);
  score += Math.min(6, density(hits, words) * 2);
  return clamp(score);
}

function scoreEmotion(text: string, words: number): number {
  const hits = countTerms(text, LEXICONS.EMOTION_TERMS);
  const firstPerson = countTerms(text.toLowerCase(), [' i ', ' my ', ' me ']);

  let score = 44;
  score += Math.min(48, density(hits, words) * 18);
  score += Math.min(10, density(firstPerson, words) * 2);
  return clamp(score);
}

function scoreStorytelling(text: string): number {
  const hits = countMatches(text, LEXICONS.STORY_PATTERNS);
  const numbers = countNumericSpecifics(text);
  const specifics = countTerms(text.toLowerCase(), [
    'percent', 'years', 'months', 'weeks', 'days', 'dollars',
  ]);

  let score = 42;
  score += Math.min(34, hits * 13);
  score += Math.min(16, numbers * 4);
  score += Math.min(10, specifics * 4);
  return clamp(score);
}

/**
 * Standalone is the dimension the heuristic engine handles best, because
 * context dependence has clear surface markers.
 */
function scoreStandalone(text: string): number {
  const opening = text.slice(0, 140);
  const dangling = countMatches(opening, LEXICONS.DANGLING_REFERENCE_PATTERNS);
  const backReference = countTerms(text.toLowerCase(), [
    'as i said', 'as i mentioned', 'like i said', 'earlier', 'before the break',
    'we talked about', 'going back to', 'that thing i', 'the other one',
  ]);
  const endsCleanly = /[.!?]["')\]]?\s*$/.test(text.trim());

  let score = 80;
  score -= Math.min(48, dangling * 24);
  score -= Math.min(24, backReference * 12);
  score += endsCleanly ? 6 : -14;

  // An unanswered question at the very end leaves the loop open.
  if (/\?\s*$/.test(text.trim())) score -= 16;

  return clamp(score);
}

function scoreShareability(text: string, words: number): number {
  const hits = countMatches(text, LEXICONS.SHAREABILITY_PATTERNS);
  const imperative = countMatches(text, [
    /\bstop (?:doing|trying|believing|telling)\b/i,
    /\bnever (?:take|do|say|forget)\b/i,
    /\balways\b/i,
    /\bwrite this down\b/i,
    /\bremember\b/i,
  ]);

  let score = 48;
  score += Math.min(38, hits * 17);
  score += Math.min(14, imperative * 6);
  score += Math.min(6, density(hits, words) * 2);
  return clamp(score);
}

function scoreClarity(text: string, words: number, wordsPerSecond: number): number {
  const filler = countTerms(text, LEXICONS.FILLER_TERMS);
  const fillerPer100 = density(filler, words);

  const sentences = text.split(/[.!?]+/).filter((part) => part.trim().length > 0);
  const averageSentenceWords = sentences.length > 0 ? words / sentences.length : words;

  let score = 84;
  score -= Math.min(52, fillerPer100 * 11);
  // Very long or very short average sentences both read as unclear.
  score -= Math.abs(averageSentenceWords - 16) > 12 ? 10 : 0;
  score -= wordsPerSecond < 1.6 || wordsPerSecond > 4 ? 8 : 0;

  return clamp(score);
}

function scoreControversy(text: string): number {
  const hits = countMatches(text, LEXICONS.CONTROVERSY_PATTERNS);
  return clamp(30 + Math.min(56, hits * 19));
}

function scoreTeachingValue(text: string, words: number): number {
  const hits = countMatches(text, LEXICONS.TEACHING_PATTERNS);
  const enumeration = countMatches(text, [
    /\bfirst\b/i, /\bsecond\b/i, /\bthird\b/i, /\bstep (?:one|two|1|2)\b/i,
  ]);

  let score = 46;
  score += Math.min(40, hits * 14);
  score += Math.min(12, enumeration * 5);
  score += Math.min(6, density(hits, words) * 2);
  return clamp(score);
}

function scoreEntertainment(text: string): number {
  const hits = countMatches(text, LEXICONS.ENTERTAINMENT_PATTERNS);
  return clamp(40 + Math.min(52, hits * 19));
}

function pickCategory(text: string): ClipCategory {
  const lower = text.toLowerCase();
  let best: { category: ClipCategory; hits: number } = { category: DEFAULT_CATEGORY, hits: 0 };

  for (const category of CLIP_CATEGORIES) {
    const hits = countTerms(lower, CATEGORY_KEYWORDS[category]);
    if (hits > best.hits) best = { category, hits };
  }

  return best.hits > 0 ? best.category : DEFAULT_CATEGORY;
}

/** Split into sentences, preserving terminal punctuation. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

const LEADING_FILLER =
  /^(?:(?:yeah|yes|no|okay|ok|right|so|and|but|well|um|uh|i mean|you know|like|totally|exactly|sure)[,.\s]+)+/i;

function stripLeadingFiller(sentence: string): string {
  const stripped = sentence.replace(LEADING_FILLER, '').trim();
  return stripped.length >= 12 ? stripped : sentence;
}

function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > 20 ? lastSpace : maxChars).trim()}...`;
}

/**
 * Build a title from the strongest sentence in the segment. Not as good as a
 * model-written title, but grounded in what was actually said, which makes it
 * safe: it can be bland, but it cannot be wrong.
 */
function buildTitle(text: string): string {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return 'Untitled moment';

  // Interviewer interjections ("Right, and how long did that last?") are short
  // and often end in a question mark, which would otherwise win on curiosity
  // signals alone and produce a title that describes nothing.
  const substantive = sentences.filter((sentence) => {
    const trimmed = sentence.trim();
    if (/\?\s*$/.test(trimmed)) return false;

    const length = stripLeadingFiller(trimmed).split(/\s+/).filter(Boolean).length;
    if (length >= 9) return true;

    // Short sentences only qualify if they carry a real signal. Otherwise
    // interviewer acknowledgements ("I hear that a lot actually") win by
    // default and produce a title that describes nothing.
    return (
      length >= 6 &&
      countMatches(trimmed, LEXICONS.HOOK_PATTERNS) +
        countMatches(trimmed, LEXICONS.SHAREABILITY_PATTERNS) >
        0
    );
  });

  const pool = substantive.length > 0 ? substantive : sentences;

  const ranked = pool
    .map((sentence) => ({
      sentence,
      score:
        countMatches(sentence, LEXICONS.HOOK_PATTERNS) * 4 +
        countMatches(sentence, LEXICONS.CURIOSITY_PATTERNS) * 2 +
        countMatches(sentence, LEXICONS.SHAREABILITY_PATTERNS) * 2 +
        // Prefer a declarative sentence with some substance to it.
        Math.min(2, sentence.split(/\s+/).length / 12) -
        countTerms(sentence, LEXICONS.FILLER_TERMS) * 2,
    }))
    .sort((a, b) => b.score - a.score);

  const chosen = stripLeadingFiller(ranked[0]?.sentence ?? pool[0]!);
  const withoutTerminal = chosen.replace(/[.]+$/, '');
  return truncateWords(withoutTerminal, 90);
}

function buildWhyThisWorks(dimensions: ClipDimensionScores, standaloneRisk: boolean): string[] {
  const tags: string[] = [];

  if (dimensions.hook >= 70) tags.push('Strong hook');
  if (dimensions.curiosity >= 68) tags.push('Opens a curiosity loop');
  if (dimensions.emotion >= 68) tags.push('High emotion');
  if (dimensions.storytelling >= 68) tags.push('Concrete story with specifics');
  if (dimensions.teachingValue >= 68) tags.push('Actionable takeaway');
  if (dimensions.controversy >= 66) tags.push('Stakes out a position');
  if (dimensions.entertainment >= 66) tags.push('Entertaining delivery');
  if (dimensions.shareability >= 68) tags.push('Highly shareable');
  if (dimensions.standalone >= 75) tags.push('Good standalone clip');
  if (dimensions.clarity >= 75) tags.push('Clean delivery');

  if (standaloneRisk) tags.push('Needs context');
  if (dimensions.clarity < 50) tags.push('Rambling delivery');
  if (dimensions.hook < 45) tags.push('Weak opening');

  if (tags.length === 0) tags.push('Average moment, no standout signal');

  return tags.slice(0, 5);
}

function buildEditingNotes(params: {
  dimensions: ClipDimensionScores;
  durationSec: number;
  firstSentence: string;
  hasNumbers: boolean;
}): string {
  const notes: string[] = [];

  notes.push(`Cut in on: "${truncateWords(params.firstSentence, 80)}"`);

  if (params.dimensions.hook < 60) {
    notes.push('Opening is soft - consider leading with the strongest line and cutting the lead-in.');
  }
  if (params.dimensions.standalone < 60) {
    notes.push('Add an on-screen title card to supply the missing context.');
  }
  if (params.dimensions.clarity < 60) {
    notes.push('Tighten with jump cuts to remove filler.');
  }
  if (params.hasNumbers) {
    notes.push('Reinforce the figures with on-screen text.');
  }
  if (params.durationSec > 70) {
    notes.push(`At ${Math.round(params.durationSec)}s this runs long - look for an earlier out point.`);
  }

  return notes.join(' ');
}

/**
 * Self-certainty for the heuristic engine.
 *
 * Higher when the signals are unambiguous - clear evidence either way. Lowest
 * when everything is mid, because that is exactly the case where lexical
 * pattern matching tells us least.
 */
function estimateSelfCertainty(dimensions: ClipDimensionScores, words: number): number {
  const values = Object.values(dimensions);
  const decisiveness =
    values.reduce((total, value) => total + Math.abs(value - 55), 0) / values.length;

  const evidenceScale = piecewise(words, [
    [10, 0.5],
    [40, 0.75],
    [90, 1],
    [260, 1],
    [400, 0.9],
  ]);

  return clamp(0.4 + (decisiveness / 45) * 0.4, 0, 1) * evidenceScale;
}

/**
 * Sponsor reads and channel housekeeping are not low-quality clips, they are
 * not clips at all. Rather than nudging their score down, we collapse the
 * dimensions that the quality gates in `clip-score.ts` act on, so a promotional
 * segment is structurally incapable of clearing the threshold no matter how
 * fluent or number-rich it is.
 */
function applyPromotionalPenalty(
  dimensions: ClipDimensionScores,
  text: string,
): { dimensions: ClipDimensionScores; promotional: boolean } {
  const hits = countMatches(text, LEXICONS.PROMOTIONAL_PATTERNS);
  if (hits === 0) return { dimensions, promotional: false };

  const severity = Math.min(1, hits / 2);

  return {
    promotional: true,
    dimensions: {
      ...dimensions,
      hook: clamp(dimensions.hook - 34 * severity),
      standalone: clamp(dimensions.standalone - 30 * severity),
      shareability: clamp(dimensions.shareability - 30 * severity),
      teachingValue: clamp(dimensions.teachingValue - 24 * severity),
      curiosity: clamp(dimensions.curiosity - 24 * severity),
      storytelling: clamp(dimensions.storytelling - 24 * severity),
    },
  };
}

export function judgeSegmentHeuristically(segment: MomentSegment): ClipJudgement {
  const text = segment.text;
  const words = wordCount(text) || segment.wordCount;

  const rawDimensions: ClipDimensionScores = {
    hook: round(scoreHook(text)),
    curiosity: round(scoreCuriosity(text, words)),
    emotion: round(scoreEmotion(text, words)),
    storytelling: round(scoreStorytelling(text)),
    standalone: round(scoreStandalone(text)),
    shareability: round(scoreShareability(text, words)),
    clarity: round(scoreClarity(text, words, segment.wordsPerSecond)),
    controversy: round(scoreControversy(text)),
    teachingValue: round(scoreTeachingValue(text, words)),
    entertainment: round(scoreEntertainment(text)),
  };

  const { dimensions, promotional } = applyPromotionalPenalty(rawDimensions, text);

  const sentences = splitSentences(text);
  const firstSentence = stripLeadingFiller(sentences[0] ?? text);
  const hasNumbers = /\b\d[\d,.]*\b/.test(text);

  const whyThisWorks = buildWhyThisWorks(dimensions, dimensions.standalone < 60);
  if (promotional) whyThisWorks.unshift('Contains a sponsor read or channel admin');

  return {
    dimensions,
    title: buildTitle(text),
    category: pickCategory(text),
    whyThisWorks: whyThisWorks.slice(0, 5),
    suggestedHook: truncateWords(firstSentence, 160),
    suggestedCaption: truncateWords(
      sentences.slice(0, 2).join(' ') || text,
      220,
    ),
    editingNotes: buildEditingNotes({
      dimensions,
      durationSec: segment.durationSec,
      firstSentence,
      hasNumbers,
    }),
    engine: 'heuristic',
    selfCertainty: round(estimateSelfCertainty(dimensions, words), 3),
  };
}
