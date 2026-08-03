import { z } from 'zod';
import type { Utterance } from '@/lib/moments/utterances';
import { isAgentActive, runJsonAgent, type AgentOverrides, type UsageLedger } from '../client';

/**
 * Phase 1 (Correctness) — Two-pass highlight selection, Pass 2.
 *
 * Pass 1 (detectMoments) produces rough candidates with coarse timestamps.
 * This agent takes the transcript context AROUND each candidate — the brief
 * specifies 15 seconds before rough_start and 20 seconds after rough_end —
 * and decides the FINAL boundaries:
 *
 *   final_start, final_end, main_topic, ending_type, ending_complete,
 *   ending_confidence, next_topic_detected, next_topic_start,
 *   next_topic_contamination
 *
 * Rules enforced downstream (§7, §8, §9):
 *   - final_end must be BEFORE next_topic_start (minus end guard)
 *   - do not pad duration to hit a target; a short complete clip beats a long
 *     contaminated one
 *   - reject candidates with no complete ending
 */

const BoundarySchema = z.object({
  segments: z
    .array(
      z.object({
        index: z.number().int().min(0),
        finalStartSec: z.number().min(0),
        finalEndSec: z.number().min(0),
        endingType: z.enum([
          'PAYOFF',
          'CONCLUSION',
          'PUNCHLINE',
          'ANSWER_COMPLETE',
          'TOPIC_TRANSITION',
          'QUESTION_START',
          'INCOMPLETE_SENTENCE',
          'FILLER',
        ]),
        endingComplete: z.boolean(),
        endingConfidence: z.number().min(0).max(1),
        nextTopicDetected: z.boolean(),
        nextTopicStart: z.number().min(0).nullable(),
        nextTopicContamination: z.number().min(0).max(1),
        reason: z.string().max(300).default(''),
      }),
    )
    .max(120),
});

const SYSTEM_PROMPT = `You are the boundary refinement editor for a podcast short-form clipping system.

You receive candidate highlight windows (rough timestamps) plus the transcript
context around them: ~15s before the rough start and ~20s after the rough end.

For each candidate decide the FINAL clip boundaries:

- finalStartSec: where the clip should actually start. Trim filler lead-in
  ("yeah", "so", "right", restatements of the question) but keep enough context
  that the hook is understandable. NEVER start mid-sentence.
- finalEndSec: where the clip should actually end. Prefer ending right after
  the answer, conclusion, payoff, or punchline. NEVER include the opening of
  the next topic. NEVER end mid-word or mid-sentence.

Ending classification:
- PAYOFF: the line that pays off the setup (best).
- CONCLUSION: the speaker wraps up the explanation.
- PUNCHLINE: a short punchy final line, often humorous.
- ANSWER_COMPLETE: a direct answer that is finished.
- TOPIC_TRANSITION / QUESTION_START / INCOMPLETE_SENTENCE / FILLER: BAD endings.

Rules:
- finalEndSec MUST be less than nextTopicStart when a next topic is detected.
- Do NOT extend the clip just to reach an ideal duration. A 29s clip with a
  clean ending beats a 45s clip contaminated by the next topic.
- If the answer is not finished yet and no new topic has started, you may
  extend slightly so the ending is complete.
- endingConfidence < 0.82 should be treated as uncertain; if you cannot find
  any complete ending, set endingComplete=false so the pipeline can repair or
  reject.

Respond with JSON only: { "segments": [ { "index": 0, "finalStartSec": ..., "finalEndSec": ..., ... } ] }`;

export interface BoundaryRefinementRequest {
  candidates: {
    index: number;
    roughStartSec: number;
    roughEndSec: number;
    roughText: string;
  }[];
  /** Utterances of the whole episode, so the agent sees surrounding context. */
  utterances: Utterance[];
  episodeTitle: string;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
}

export interface BoundaryRefinementItem {
  index: number;
  finalStartSec: number;
  finalEndSec: number;
  endingType: string;
  endingComplete: boolean;
  endingConfidence: number;
  nextTopicDetected: boolean;
  nextTopicStart: number | null;
  nextTopicContamination: number;
  reason: string;
}

export interface BoundaryRefinementResult {
  items: BoundaryRefinementItem[];
  aiGenerated: boolean;
  warnings: string[];
}

function formatUtterance(u: Utterance): string {
  return `[${u.startSec.toFixed(1)}-${u.endSec.toFixed(1)}] ${u.text}`;
}

export async function refineBoundaries(
  request: BoundaryRefinementRequest,
): Promise<BoundaryRefinementResult> {
  const passthrough: BoundaryRefinementResult = {
    items: request.candidates.map((c) => ({
      index: c.index,
      finalStartSec: c.roughStartSec,
      finalEndSec: c.roughEndSec,
      endingType: 'CONCLUSION',
      endingComplete: true,
      endingConfidence: 0.5,
      nextTopicDetected: false,
      nextTopicStart: null,
      nextTopicContamination: 0,
      reason: 'agent unavailable, kept rough boundaries',
    })),
    aiGenerated: false,
    warnings: [],
  };

  if (request.candidates.length === 0) return passthrough;
  if (!isAgentActive('moment_detection', request.overrides)) return passthrough;

  try {
    const { data } = await runJsonAgent({
      role: 'moment_detection',
      system: SYSTEM_PROMPT,
      user: `Episode: ${request.episodeTitle}

Candidate windows (rough):
${request.candidates
  .map(
    (c) =>
      `index ${c.index}: ${c.roughStartSec.toFixed(1)}-${c.roughEndSec.toFixed(1)}s — "${c.roughText.slice(0, 180)}"`,
  )
  .join('\n')}

Transcript context (utterances):
${request.utterances.map(formatUtterance).join('\n')}`,
      parse: (value) => BoundarySchema.parse(value),
      overrides: request.overrides,
      ledger: request.ledger,
      signal: request.signal,
    });

    const decisions = new Map(data.segments.map((s) => [s.index, s]));
    const items: BoundaryRefinementItem[] = request.candidates.map((c) => {
      const d = decisions.get(c.index);
      if (!d) {
        return {
          index: c.index,
          finalStartSec: c.roughStartSec,
          finalEndSec: c.roughEndSec,
          endingType: 'CONCLUSION',
          endingComplete: true,
          endingConfidence: 0.5,
          nextTopicDetected: false,
          nextTopicStart: null,
          nextTopicContamination: 0,
          reason: 'no decision from agent, kept rough boundaries',
        };
      }
      return {
        index: c.index,
        finalStartSec: d.finalStartSec,
        finalEndSec: d.finalEndSec,
        endingType: d.endingType,
        endingComplete: d.endingComplete,
        endingConfidence: d.endingConfidence,
        nextTopicDetected: d.nextTopicDetected,
        nextTopicStart: d.nextTopicStart,
        nextTopicContamination: d.nextTopicContamination,
        reason: d.reason,
      };
    });

    return { items, aiGenerated: true, warnings: [] };
  } catch (error) {
    return {
      ...passthrough,
      warnings: [
        `Boundary refinement agent unavailable, using rough boundaries: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      ],
    };
  }
}
