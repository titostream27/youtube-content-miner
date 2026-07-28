import type {
  ClipDimensionScores,
  MomentSegment,
  ScoringEngineName,
  TranscriptSource,
} from '@/lib/domain/types';
import { CLIP_DIMENSION_KEYS } from '@/lib/domain/types';
import { bell, clamp, round, standardDeviation } from './normalize';

/**
 * PRD Step 6 - Confidence.
 *
 * Score and confidence answer two different questions:
 *
 *   score      - "how good is this clip?"
 *   confidence - "how much should you trust that score?"
 *
 * A 96 at 93% confidence goes straight to the editor. A 96 at 54% confidence
 * needs a human to watch 30 seconds first. Separating them is what makes the
 * "Publish Immediately" tier trustworthy enough to act on without review.
 *
 * Confidence is derived from the quality of the evidence, never from the score
 * itself, with one exception: proximity to a tier boundary legitimately
 * reduces how confidently we can place a clip in a tier.
 */

const TRANSCRIPT_RELIABILITY: Record<TranscriptSource, number> = {
  // Human authored captions: punctuation and speaker turns are trustworthy.
  youtube_manual: 100,
  // ASR: usable, but missing punctuation degrades hook and standalone reads.
  youtube_asr: 86,
  // Our own STT pass: similar to ASR, slightly less tuned for the channel.
  speech_to_text: 80,
  // Deterministic demo data: clean text, but not real audio.
  fixture: 90,
};

const CONFIDENCE_WEIGHTS = {
  transcriptReliability: 0.22,
  engineCertainty: 0.2,
  speechDensity: 0.14,
  durationFit: 0.1,
  boundaryClarity: 0.14,
  evidenceCoverage: 0.08,
  signalCoherence: 0.12,
} as const;

/**
 * The heuristic engine reads lexical patterns, not meaning. It is genuinely
 * useful for ranking but it should never claim near-certainty, so its output
 * is capped. This keeps "high confidence" honest.
 */
const ENGINE_CONFIDENCE_CEILING: Record<ScoringEngineName, number> = {
  llm: 97,
  heuristic: 82,
};

const TIER_BOUNDARIES = [80, 85, 90, 95];

/**
 * A score of 94.6 is one rounding step away from a different tier, so our
 * placement of it is less certain than a score of 92.
 */
function scoreBoundaryClarity(finalScore: number): number {
  const distances = TIER_BOUNDARIES.map((boundary) => Math.abs(finalScore - boundary));
  const nearest = Math.min(...distances);
  // 0 points away -> 55, 3+ points away -> 100.
  return clamp(55 + (Math.min(nearest, 3) / 3) * 45);
}

/**
 * Words per second. Natural conversational speech sits around 2.3-2.9 wps.
 * Far below suggests dead air or a broken transcript; far above suggests
 * caption timing errors. Both make every other signal less reliable.
 */
function scoreSpeechDensity(wordsPerSecond: number): number {
  return clamp(bell(wordsPerSecond, 2.6, 1.15));
}

function scoreDurationFit(durationSec: number): number {
  return clamp(bell(durationSec, 42, 26));
}

/**
 * How much explicit evidence the engine produced. An engine that returns four
 * concrete reasons has demonstrably engaged with the content; one that returns
 * a single generic tag has not.
 */
function scoreEvidenceCoverage(whyThisWorks: readonly string[]): number {
  const usable = whyThisWorks.filter((reason) => reason.trim().length > 3).length;
  return clamp((Math.min(usable, 4) / 4) * 100);
}

/**
 * Signal coherence. When the ten dimensions all point the same way the
 * judgement is internally consistent. Wild spread (a 95 hook next to a 20
 * clarity) means the engine is unsure what it is looking at.
 */
function scoreSignalCoherence(dimensions: ClipDimensionScores): number {
  const values = CLIP_DIMENSION_KEYS.map((key) => dimensions[key]);
  const spread = standardDeviation(values);
  // Spread is expected and healthy - the scoring model in `clip-score.ts` is
  // built on the premise that good clips peak on two dimensions rather than
  // being uniformly strong. Only extreme spread signals genuine confusion.
  return clamp(100 - Math.max(0, spread - 20) * 2.6);
}

export interface ConfidenceInput {
  dimensions: ClipDimensionScores;
  finalScore: number;
  segment: Pick<MomentSegment, 'durationSec' | 'wordsPerSecond'>;
  transcriptSource: TranscriptSource;
  whyThisWorks: readonly string[];
  /** Engine self-reported certainty, 0-1. */
  selfCertainty: number;
  engine: ScoringEngineName;
}

export interface ConfidenceResult {
  /** 0-100. Rendered as a percentage. */
  confidence: number;
  components: Record<keyof typeof CONFIDENCE_WEIGHTS, number>;
}

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const components = {
    transcriptReliability: TRANSCRIPT_RELIABILITY[input.transcriptSource],
    engineCertainty: clamp(input.selfCertainty * 100),
    speechDensity: scoreSpeechDensity(input.segment.wordsPerSecond),
    durationFit: scoreDurationFit(input.segment.durationSec),
    boundaryClarity: scoreBoundaryClarity(input.finalScore),
    evidenceCoverage: scoreEvidenceCoverage(input.whyThisWorks),
    signalCoherence: scoreSignalCoherence(input.dimensions),
  };

  let confidence = 0;
  for (const key of Object.keys(CONFIDENCE_WEIGHTS) as (keyof typeof CONFIDENCE_WEIGHTS)[]) {
    confidence += components[key] * CONFIDENCE_WEIGHTS[key];
  }

  const ceiling = ENGINE_CONFIDENCE_CEILING[input.engine];

  return {
    confidence: round(clamp(Math.min(confidence, ceiling))),
    components: {
      transcriptReliability: round(components.transcriptReliability),
      engineCertainty: round(components.engineCertainty),
      speechDensity: round(components.speechDensity),
      durationFit: round(components.durationFit),
      boundaryClarity: round(components.boundaryClarity),
      evidenceCoverage: round(components.evidenceCoverage),
      signalCoherence: round(components.signalCoherence),
    },
  };
}
