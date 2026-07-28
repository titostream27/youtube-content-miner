import { z } from 'zod';
import type { MomentSegment } from '@/lib/domain/types';
import { formatTimecode } from '@/lib/youtube/duration';
import { round } from '@/lib/scoring/normalize';
import { isAgentActive, runJsonAgent, type AgentOverrides, type UsageLedger } from '../client';

/**
 * PRD Step 4 - semantic refinement of the candidate windows.
 *
 * Segmentation gives us windows that start and end on sentence boundaries, but
 * a sentence boundary is not always a good in-point. Conversations routinely
 * begin a great answer with fifteen seconds of "yeah, so, right, I think what
 * you're asking is..." before the actual moment starts.
 *
 * This agent does two cheap things before the expensive scoring pass:
 *  - drops windows that are sponsor reads, admin chatter or pure filler
 *  - trims dead lead-in and trailing drift off the windows it keeps
 *
 * It can only trim INWARD. It cannot extend a window, invent timestamps, or
 * move a boundary outside the original span, so a bad response degrades the
 * result slightly instead of producing clips that point at the wrong audio.
 */

const MAX_TRIM_SEC = 20;

const RefinementSchema = z.object({
  segments: z
    .array(
      z.object({
        index: z.number().int().min(0),
        keep: z.boolean(),
        trimStartSec: z.number().min(0).max(MAX_TRIM_SEC).default(0),
        trimEndSec: z.number().min(0).max(MAX_TRIM_SEC).default(0),
        reason: z.string().max(200).default(''),
      }),
    )
    .max(120),
});

const SYSTEM_PROMPT = `You are the moment detection editor for a podcast content intelligence platform.

You receive candidate transcript windows from one episode. For each window decide:

- keep: false if the window is a sponsor read, housekeeping ("before we get into it", "link in the description"), pure filler, an unresolved question with no answer inside the window, or a passage that cannot be understood without the preceding conversation. Otherwise true.
- trimStartSec: seconds of dead lead-in to remove so the clip opens on the strongest line. Filler acknowledgements ("yeah", "right", "so", "I mean"), restatements of the question, and throat-clearing should be trimmed. 0 if the window already opens well.
- trimEndSec: seconds of trailing drift to remove so the clip ends on the payoff instead of wandering into the next topic. 0 if it already ends cleanly.
- reason: one short phrase.

Constraints you must respect:
- Never trim more than ${MAX_TRIM_SEC} seconds from either end.
- Never trim so much that less than 15 seconds of content remains; if the window only works at full length, return 0 for both trims.
- Return one entry for every index you were given, using the exact index numbers.

Respond with JSON only: { "segments": [ { "index": 0, "keep": true, "trimStartSec": 0, "trimEndSec": 0, "reason": "..." } ] }`;

export interface MomentRefinementRequest {
  segments: MomentSegment[];
  episodeTitle: string;
  minDurationSec: number;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
}

export interface MomentRefinementResult {
  segments: MomentSegment[];
  droppedCount: number;
  trimmedCount: number;
  aiGenerated: boolean;
  warnings: string[];
}

function describeSegment(segment: MomentSegment): string {
  return [
    `index: ${segment.index}`,
    `time: ${formatTimecode(segment.startSec)} - ${formatTimecode(segment.endSec)} (${Math.round(
      segment.durationSec,
    )}s)`,
    `text: ${segment.text}`,
  ].join('\n');
}

export async function refineMoments(
  request: MomentRefinementRequest,
): Promise<MomentRefinementResult> {
  const passthrough: MomentRefinementResult = {
    segments: request.segments,
    droppedCount: 0,
    trimmedCount: 0,
    aiGenerated: false,
    warnings: [],
  };

  if (request.segments.length === 0) return passthrough;
  if (!isAgentActive('moment_detection', request.overrides)) return passthrough;

  try {
    const { data } = await runJsonAgent({
      role: 'moment_detection',
      system: SYSTEM_PROMPT,
      user: `Episode: ${request.episodeTitle}\n\nCandidate windows:\n\n${request.segments
        .map(describeSegment)
        .join('\n\n---\n\n')}`,
      parse: (value) => RefinementSchema.parse(value),
      overrides: request.overrides,
      ledger: request.ledger,
      signal: request.signal,
    });

    const decisions = new Map(data.segments.map((item) => [item.index, item]));

    let droppedCount = 0;
    let trimmedCount = 0;
    const kept: MomentSegment[] = [];

    for (const segment of request.segments) {
      const decision = decisions.get(segment.index);

      // No decision for this window means keep it untouched.
      if (!decision) {
        kept.push(segment);
        continue;
      }

      if (!decision.keep) {
        droppedCount += 1;
        continue;
      }

      const trimStart = Math.max(0, Math.min(MAX_TRIM_SEC, decision.trimStartSec));
      const trimEnd = Math.max(0, Math.min(MAX_TRIM_SEC, decision.trimEndSec));
      const remaining = segment.durationSec - trimStart - trimEnd;

      // Reject a trim that would leave an unusably short clip.
      if (trimStart + trimEnd === 0 || remaining < request.minDurationSec) {
        kept.push(segment);
        continue;
      }

      const startSec = round(segment.startSec + trimStart, 2);
      const endSec = round(segment.endSec - trimEnd, 2);
      const durationSec = round(endSec - startSec, 2);

      // The transcript text still covers the original span. Rather than
      // guessing which words fall inside the trimmed range, we keep the text
      // and let scoring read slightly more context than the cut will contain -
      // a safer error than mislabelling the clip's content.
      kept.push({
        ...segment,
        startSec,
        endSec,
        durationSec,
        wordsPerSecond: round(segment.wordCount / Math.max(1, durationSec), 2),
      });
      trimmedCount += 1;
    }

    return {
      segments: kept.map((segment, index) => ({ ...segment, index })),
      droppedCount,
      trimmedCount,
      aiGenerated: true,
      warnings: [],
    };
  } catch (error) {
    return {
      ...passthrough,
      warnings: [
        `Moment detection agent unavailable, using deterministic windows: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      ],
    };
  }
}
