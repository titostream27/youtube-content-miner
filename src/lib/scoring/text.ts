/**
 * Lexical analysis helpers.
 *
 * These power two things:
 *  1. Topic relevance in the Episode Opportunity Score.
 *  2. The heuristic scoring engine, which lets the whole pipeline run with no
 *     LLM credentials at all (see `src/lib/ai/heuristic-engine.ts`).
 *
 * Everything here is deliberately deterministic. The same transcript always
 * produces the same score, which makes the pipeline debuggable and makes
 * regressions in the scoring model visible.
 */

const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
  'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not', 'of',
  'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'out', 'over', 'own', 'same',
  'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until',
  'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'will', 'with', 'you', 'your', 'yours',
]);

/** Conversational filler that signals a low-clarity, rambling segment. */
const FILLER_TERMS = [
  'um', 'uh', 'erm', 'you know', 'i mean', 'kind of', 'sort of', 'like i said',
  'whatever', 'blah', 'anyway', 'right?', 'yeah yeah',
];

/**
 * Openers and constructions that stop a scroll.
 *
 * Kept broad on purpose. A narrow hook lexicon systematically under-rates
 * genuinely strong openings - "the single most useful thing I learned in fifteen
 * years" is a textbook hook that matches none of the obvious clickbait
 * templates. Under the top-2 driver model in `clip-score.ts`, missing the hook
 * on a strong clip costs it a whole tier.
 */
const HOOK_PATTERNS: RegExp[] = [
  // Contrarian and corrective framings.
  /\bnobody (?:tells|talks about|knows|shares|asks|reads|does)\b/i,
  /\bhere'?s (?:why|what|how|the)\b/i,
  /\bthe (?:biggest|worst|number one|#1|hardest|real|actual|single) (?:mistake|problem|reason|lie|myth|story|answer|thing)\b/i,
  /\bthe (?:single )?most (?:useful|important|expensive|dangerous|valuable|common|overrated|underrated)\b/i,
  /\bmost people\b/i,
  /\beveryone (?:thinks|believes|asks|gets .{0,12}wrong)\b/i,
  /\bthe truth (?:is|about)\b/i,
  /\bwrong question\b/i,
  // Definitional reversals: "X is not Y, it's Z".
  /\b(?:is|are) not (?:a |an |the )?\w+[,.]? it(?:'s| is)\b/i,
  /\b(?:is|are) (?:not|never) (?:about|what|a discipline|a prediction)\b/i,
  /\bnot because\b.{0,60}\bbecause\b/i,
  // Personal reversal and stakes.
  /\bi was (?:wrong|broke|fired|terrified|young and stupid)\b/i,
  /\bi (?:stopped|quit|lost|failed)\b/i,
  /\bthe best \w+ i ever\b/i,
  /\bi have never (?:forgotten|met|once)\b/i,
  /\bwe measured it\b/i,
  // Direct address and instruction.
  /\blet me (?:tell you|explain)\b/i,
  /\bthis (?:changed|destroyed|saved) (?:my|everything)\b/i,
  /\bstop (?:doing|trying|believing|telling|using)\b/i,
  /\byou will never\b/i,
  /\bif you (?:want|are|do|have)\b.{0,40}\bthen\b/i,
  /\bhere is the (?:thing|problem|exercise|test|question)\b/i,
  // Quantified claims.
  /\b(?:ninety|eighty|seventy|sixty|fifty|\d{2}) percent of\b/i,
  // Question openers.
  /^\s*(?:why|how|what|when) .{0,60}\?/i,
];

const CURIOSITY_PATTERNS: RegExp[] = [
  /\b(?:secret|hidden|unknown|surprising|counterintuitive|nobody realises|nobody realizes)\b/i,
  /\b(?:turns out|it turned out|plot twist|the catch is)\b/i,
  /\bwait (?:until|till)\b/i,
  /\byou (?:won'?t|will never) (?:believe|guess)\b/i,
  /\b(?:actually|surprisingly|shockingly|weirdly)\b/i,
  /\?\s*$/,
];

const EMOTION_TERMS = [
  'love', 'hate', 'fear', 'afraid', 'terrified', 'scared', 'angry', 'furious', 'devastated',
  'heartbroken', 'grief', 'cried', 'crying', 'tears', 'ashamed', 'humiliated', 'proud',
  'grateful', 'anxious', 'anxiety', 'depressed', 'depression', 'burnout', 'lonely', 'desperate',
  'panic', 'regret', 'guilt', 'joy', 'excited', 'thrilled', 'shocked', 'stunned', 'betrayed',
  'painful', 'suffering', 'struggle', 'struggled', 'rock bottom', 'gave up', 'broke down',
  'apologised', 'apologized', 'humiliating', 'humiliated', 'shame', 'shameful',
  'never forgotten', 'worst part', 'unfair', 'not fair', 'betrayal', 'protecting',
  'resentment', 'exhausted', 'exhausting', 'hardship', 'quit', 'stuck',
];

const STORY_PATTERNS: RegExp[] = [
  /\b(?:when i was|back (?:in|when)|one day|a few (?:years|months|weeks) ago|at the time)\b/i,
  /\bi (?:remember|walked|called|met|realised|realized|decided|quit|started)\b/i,
  /\b(?:so|then) i\b/i,
  /\bhe (?:said|told me)\b|\bshe (?:said|told me)\b|\bthey (?:said|told me)\b/i,
  /\bthe (?:first|last) time\b/i,
  /\bthat'?s when\b/i,
];

const TEACHING_PATTERNS: RegExp[] = [
  /\b(?:two|three|four|five|2|3|4|5) (?:things|reasons|rules|steps|ways|lessons|principles|questions)\b/i,
  /\b(?:first|second|third|finally|lastly)\b.{0,80}\b(?:second|third|then|next|finally)\b/is,
  /\b(?:framework|principle|rule of thumb|heuristic|formula|playbook|blueprint|system)\b/i,
  /\bthe way (?:to|you|we)\b/i,
  /\bwhat (?:i|you) (?:learned|should do)\b/i,
  /\bfor example\b/i,
  // Explicit instruction to the listener - the strongest teaching signal there
  // is, and the one most likely to be clipped as a standalone lesson.
  /\bwrite (?:this|that|it) down\b|\bwrite down\b/i,
  /\bhere is the exercise\b|\bthe exercise that\b/i,
  /\bthe (?:test|question|exercise) i (?:give|ask|use)\b/i,
  /\bthe (?:first|only) question (?:is|i ask)\b/i,
  /\bask (?:yourself|what|whether)\b/i,
  /\bthe answer (?:is|isn'?t)\b/i,
  /\bwhat you can (?:do|schedule|control)\b/i,
  /\bthat is the (?:whole game|entire job|one thing)\b/i,
];

const CONTROVERSY_PATTERNS: RegExp[] = [
  /\b(?:disagree|wrong|nonsense|bullshit|scam|lie|lying|overrated|myth|hype|dead|broken)\b/i,
  /\bunpopular opinion\b/i,
  /\bi don'?t (?:think|believe|buy)\b/i,
  /\bthat'?s (?:not true|a lie|garbage)\b/i,
  /\b(?:hot take|controversial)\b/i,
];

const ENTERTAINMENT_PATTERNS: RegExp[] = [
  /\[(?:laughter|laughs|laughing|applause)\]/i,
  /\b(?:hilarious|ridiculous|insane|crazy|absurd|wild)\b/i,
  /\bhaha+\b/i,
  /\b(?:funniest|joke|comedy)\b/i,
];

const SHAREABILITY_PATTERNS: RegExp[] = [
  /\b(?:everyone|anyone) (?:should|needs to|has to)\b/i,
  /\bremember this\b/i,
  /\bthe (?:one|single) thing\b/i,
  /\b(?:never|always) (?:do|say|forget)\b/i,
  /\bwrite this down\b/i,
];

/**
 * Sponsor reads and channel admin.
 *
 * These are the single most common false positive in clip mining: they are
 * fluent, well-rehearsed, full of concrete numbers ("twenty percent off your
 * first three months") and therefore score deceptively well on storytelling and
 * clarity. They are also completely unpublishable as content.
 */
const PROMOTIONAL_PATTERNS: RegExp[] = [
  /\b(?:today'?s |our )?sponsor(?:s|ed)?\b/i,
  /\bbrought to you by\b/i,
  /\blink in the (?:description|bio|show notes)\b/i,
  /\b(?:promo |discount )?code\b.{0,30}\b(?:off|checkout)\b/i,
  /\b\d{1,2}\s*percent off\b|\b(?:ten|fifteen|twenty|thirty|fifty) percent off\b/i,
  /\bour friends (?:over )?at\b/i,
  /\b(?:like and )?subscribe\b/i,
  /\b(?:patreon|newsletter|mailing list)\b/i,
  /\bfree trial\b/i,
  /\bbefore we (?:get into it|start|begin)\b/i,
  /\bquick word from\b/i,
];

/**
 * Openings that prove the segment depends on earlier context, which is the
 * single most common reason a high-scoring moment fails as a standalone clip.
 */
const DANGLING_REFERENCE_PATTERNS: RegExp[] = [
  /^\s*(?:and|but|so|because|which|also|then|plus|however|anyway|okay|ok|right|yeah|no)\b/i,
  /^\s*(?:that|this|those|these|it|he|she|they|him|her|them)\b/i,
  /\b(?:as i (?:said|mentioned)|like i (?:said|mentioned)|going back to|as we discussed)\b/i,
  /^\s*(?:exactly|totally|absolutely|correct|true)\b/i,
];

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

export function contentTerms(text: string): string[] {
  return tokenize(text).filter((token) => !STOPWORDS.has(token));
}

export function wordCount(text: string): number {
  return tokenize(text).length;
}

/** Count how many of the supplied patterns match. */
export function countMatches(text: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((count, pattern) => (pattern.test(text) ? count + 1 : count), 0);
}

/** Count occurrences of any of the supplied terms. */
export function countTerms(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((count, term) => {
    let index = lower.indexOf(term);
    let hits = 0;
    while (index !== -1) {
      hits += 1;
      index = lower.indexOf(term, index + term.length);
    }
    return count + hits;
  }, 0);
}

/**
 * Fraction (0-1) of the topic's meaningful terms that appear in `haystack`.
 * Handles multi-word topics and simple plural/suffix variation.
 */
export function termCoverage(topic: string, haystack: string): number {
  const terms = Array.from(new Set(contentTerms(topic)));
  if (terms.length === 0) return 0;

  const target = ` ${tokenize(haystack).join(' ')} `;
  const matched = terms.filter((term) => {
    if (target.includes(` ${term} `)) return true;
    const stem = term.replace(/(?:ing|ed|es|s)$/, '');
    return stem.length >= 4 && target.includes(` ${stem}`);
  });

  return matched.length / terms.length;
}

export const LEXICONS = {
  FILLER_TERMS,
  PROMOTIONAL_PATTERNS,
  HOOK_PATTERNS,
  CURIOSITY_PATTERNS,
  EMOTION_TERMS,
  STORY_PATTERNS,
  TEACHING_PATTERNS,
  CONTROVERSY_PATTERNS,
  ENTERTAINMENT_PATTERNS,
  SHAREABILITY_PATTERNS,
  DANGLING_REFERENCE_PATTERNS,
} as const;
