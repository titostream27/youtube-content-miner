import { z } from 'zod';
import { coerceCategory } from '@/lib/domain/categories';
import { CLIP_CATEGORIES } from '@/lib/domain/categories';
import type { ClipJudgement, MomentSegment } from '@/lib/domain/types';
import { config } from '@/lib/config';
import { chunk, mapWithConcurrency } from '@/lib/utils/concurrency';
import { formatTimecode } from '@/lib/youtube/duration';
import { isAgentActive, runJsonAgent, type AgentOverrides, type UsageLedger } from '../client';

/**
 * PRD Step 5, 8 and 10 - the agent that decides what the product is worth.
 *
 * It scores each candidate moment on the ten dimensions, assigns a category,
 * and explains itself. The explanation is not decoration: the PRD's success
 * metric is high-confidence clips that actually get published, and an editor
 * will not act on a number they cannot interrogate.
 *
 * Design decisions worth noting:
 *  - Segments are scored in small batches. Batching cuts cost and gives the
 *    model comparative context, which produces better calibrated scores than
 *    judging each moment in isolation.
 *  - The prompt forces an explicit score distribution. Left unconstrained,
 *    every model rates everything 80-90 and the threshold tiers collapse into
 *    one bucket, which destroys the entire point of Step 7.
 *  - `certainty` is requested separately from the scores and feeds the
 *    confidence model in `scoring/confidence.ts`. The final confidence is never
 *    just the model's self-report.
 */

const DimensionsSchema = z.object({
  hook: z.number().min(0).max(100),
  curiosity: z.number().min(0).max(100),
  emotion: z.number().min(0).max(100),
  storytelling: z.number().min(0).max(100),
  standalone: z.number().min(0).max(100),
  shareability: z.number().min(0).max(100),
  clarity: z.number().min(0).max(100),
  controversy: z.number().min(0).max(100),
  teachingValue: z.number().min(0).max(100),
  entertainment: z.number().min(0).max(100),
});

const ClipJudgementSchema = z.object({
  index: z.number().int().min(0),
  title: z.string().min(3).max(120),
  category: z.string().min(2).max(40),
  scores: DimensionsSchema,
  whyThisWorks: z.array(z.string().min(2).max(80)).min(1).max(6),
  suggestedHook: z.string().max(200).default(''),
  suggestedCaption: z.string().max(400).default(''),
  editingNotes: z.string().max(400).default(''),
  certainty: z.number().min(0).max(1),
});

const BatchResponseSchema = z.object({
  clips: z.array(ClipJudgementSchema).max(30),
});

const SYSTEM_PROMPT = `You are a senior short-form content producer for a top podcast network. You have cut thousands of clips and you know exactly which moments perform and which die in the first three seconds.

You will receive candidate moments from one podcast episode. Score each one on ten dimensions, 0-100:

- hook: does the FIRST sentence stop a scroll? A clip that needs ten seconds of setup scores below 40 here no matter how good the payoff is.
- curiosity: does it open a loop the viewer needs closed?
- emotion: genuine emotional charge - vulnerability, anger, grief, awe. Not enthusiasm.
- storytelling: is there a concrete narrative with specifics (people, places, numbers, stakes)? Abstract advice scores low.
- standalone: can someone who has never heard this podcast understand it completely with no other context? Unresolved pronouns, references to "what he said earlier", or answers to an unheard question score below 40.
- shareability: would a viewer send this to a specific person they know?
- clarity: is the point delivered cleanly, without rambling, hedging or filler?
- controversy: does it stake out a position someone would argue with? Do NOT reward mere rudeness.
- teachingValue: does the viewer leave knowing something actionable?
- entertainment: is it funny, surprising or charismatic to watch?

CALIBRATION - this is the most important instruction:
Most podcast moments are mediocre. Your scores must spread out, or the product is useless.
- Across any batch, the MEDIAN dimension score should sit near 55-65.
- Reserve 90+ on a dimension for genuinely exceptional cases - roughly one moment in twenty.
- Use scores below 40 freely. A sponsor read, a rambling non-answer or a context-dependent fragment SHOULD score in the teens and twenties.
- Do not compress everything into the 70-85 band. If two moments differ in quality, their scores must differ clearly.

Also return for each moment:
- title: how the clip would be titled on a shorts feed. Specific, no clickbait punctuation, no emoji, max 12 words.
- category: exactly one of: ${CLIP_CATEGORIES.join(', ')}.
- whyThisWorks: 2 to 4 SHORT tags naming the actual mechanism, e.g. "Strong hook", "Unexpected statement", "High emotion", "Clear ending", "Concrete numbers", "Good standalone clip", "Needs context". Be honest - include a negative tag when one applies.
- suggestedHook: the exact opening line an editor should cut on, quoted from the transcript where possible.
- suggestedCaption: a publish-ready caption, one or two sentences, no hashtags.
- editingNotes: concrete instruction for the editor - where to cut, what to trim, whether b-roll or on-screen text is needed.
- certainty: 0 to 1, how confident YOU are in this judgement. Lower it when the transcript is garbled, the speaker is ambiguous, or the moment's quality depends on delivery you cannot hear.

Respond with JSON only:
{ "clips": [ { "index": 0, "title": "...", "category": "...", "scores": { "hook": 0, "curiosity": 0, "emotion": 0, "storytelling": 0, "standalone": 0, "shareability": 0, "clarity": 0, "controversy": 0, "teachingValue": 0, "entertainment": 0 }, "whyThisWorks": ["..."], "suggestedHook": "...", "suggestedCaption": "...", "editingNotes": "...", "certainty": 0.0 } ] }`;

function describeSegment(segment: MomentSegment): string {
  return [
    `index: ${segment.index}`,
    `start: ${formatTimecode(segment.startSec)}  duration: ${Math.round(segment.durationSec)}s`,
    `transcript: ${segment.text}`,
  ].join('\n');
}

export interface ClipScoringRequest {
  segments: MomentSegment[];
  episodeTitle: string;
  channelTitle: string;
  topic: string | null;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
}

export interface ClipScoringResult {
  /** Keyed by segment index. Absent entries fall back to the heuristic engine. */
  judgements: Map<number, ClipJudgement>;
  warnings: string[];
  batches: number;
  failedBatches: number;
}

export function isClipScoringAgentActive(overrides?: AgentOverrides): boolean {
  return isAgentActive('clip_scoring', overrides);
}

export async function scoreSegmentsWithAgent(
  request: ClipScoringRequest,
): Promise<ClipScoringResult> {
  const judgements = new Map<number, ClipJudgement>();
  const warnings: string[] = [];

  if (request.segments.length === 0 || !isClipScoringAgentActive(request.overrides)) {
    return { judgements, warnings, batches: 0, failedBatches: 0 };
  }

  const batches = chunk(request.segments, Math.max(1, config.ai.batchSize));
  let failedBatches = 0;

  const context = [
    `Episode: ${request.episodeTitle}`,
    `Channel: ${request.channelTitle}`,
    request.topic ? `Requested topic: ${request.topic}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const batchResults = await mapWithConcurrency(
    batches,
    config.ai.concurrency,
    async (batch) => {
      try {
        const { data } = await runJsonAgent({
          role: 'clip_scoring',
          system: SYSTEM_PROMPT,
          user: `${context}\n\nCandidate moments:\n\n${batch
            .map(describeSegment)
            .join('\n\n---\n\n')}`,
          parse: (value) => BatchResponseSchema.parse(value),
          overrides: request.overrides,
          ledger: request.ledger,
          signal: request.signal,
        });

        const validIndexes = new Set(batch.map((segment) => segment.index));
        return {
          clips: data.clips.filter((clip) => validIndexes.has(clip.index)),
          error: null as string | null,
        };
      } catch (error) {
        return {
          clips: [],
          error: error instanceof Error ? error.message : 'unknown scoring error',
        };
      }
    },
  );

  for (const result of batchResults) {
    if (result.error) {
      failedBatches += 1;
      warnings.push(`Clip scoring batch failed, falling back to heuristics: ${result.error}`);
      continue;
    }

    for (const clip of result.clips) {
      judgements.set(clip.index, {
        dimensions: clip.scores,
        title: clip.title.trim(),
        category: coerceCategory(clip.category),
        whyThisWorks: clip.whyThisWorks.map((reason) => reason.trim()).filter(Boolean),
        suggestedHook: clip.suggestedHook.trim(),
        suggestedCaption: clip.suggestedCaption.trim(),
        editingNotes: clip.editingNotes.trim(),
        engine: 'llm',
        selfCertainty: clip.certainty,
      });
    }
  }

  return { judgements, warnings, batches: batches.length, failedBatches };
}
