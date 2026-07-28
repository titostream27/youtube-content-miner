import { z } from 'zod';
import { coerceCategory } from '@/lib/domain/categories';
import { CLIP_CATEGORIES } from '@/lib/domain/categories';
import type { ScoredClip } from '@/lib/domain/types';
import { config } from '@/lib/config';
import { chunk, mapWithConcurrency } from '@/lib/utils/concurrency';
import { isAgentActive, runJsonAgent, type AgentOverrides, type UsageLedger } from '../client';

/**
 * PRD Step 8 - publish-ready metadata.
 *
 * Scoring and copywriting are different skills and benefit from different
 * settings: scoring wants a low temperature and a sceptical frame, copywriting
 * wants a higher temperature and a creative one. Splitting them into two agents
 * lets each run on the model and temperature that suits it.
 *
 * This pass only runs on clips that already cleared the threshold, so we never
 * pay to write a caption for a clip nobody will cut. It refines wording only -
 * it cannot change a score, a tier, or a timestamp.
 */

const MetadataSchema = z.object({
  clips: z
    .array(
      z.object({
        index: z.number().int().min(0),
        title: z.string().min(3).max(120),
        category: z.string().min(2).max(40).optional(),
        suggestedHook: z.string().min(3).max(220),
        suggestedCaption: z.string().min(3).max(400),
        editingNotes: z.string().min(3).max(400),
      }),
    )
    .max(40),
});

const SYSTEM_PROMPT = `You write publish-ready metadata for short-form podcast clips.

For each clip you receive the transcript and its current draft metadata. Rewrite the copy so an editor and a social manager can act on it immediately.

- title: how this would appear on a shorts feed. Specific and concrete, drawn from what is actually said. Maximum 12 words. No emoji, no ALL CAPS, no "you won't believe", no trailing punctuation.
- suggestedHook: the exact opening line to cut on. Quote the transcript verbatim wherever possible - the editor has to find this line in the audio.
- suggestedCaption: one or two sentences for the post. Plain, direct, no hashtags, no emoji.
- editingNotes: concrete direction. Where to cut in and out, what filler to remove, whether on-screen text or b-roll is needed, and any context the viewer needs supplied.
- category: exactly one of ${CLIP_CATEGORIES.join(', ')}. Only include this field if the current category is clearly wrong.

Never invent quotes, statistics, names or claims that are not in the transcript. Return one entry per index using the exact index numbers given.

Respond with JSON only: { "clips": [ { "index": 0, "title": "...", "suggestedHook": "...", "suggestedCaption": "...", "editingNotes": "..." } ] }`;

export interface ClipMetadataRequest {
  clips: ScoredClip[];
  episodeTitle: string;
  overrides?: AgentOverrides;
  ledger?: UsageLedger;
  signal?: AbortSignal;
}

export interface ClipMetadataResult {
  clips: ScoredClip[];
  refinedCount: number;
  warnings: string[];
}

function describeClip(clip: ScoredClip): string {
  return [
    `index: ${clip.segmentIndex}`,
    `current title: ${clip.title}`,
    `category: ${clip.category}`,
    `score: ${clip.finalScore} (${clip.tier})`,
    `duration: ${Math.round(clip.durationSec)}s`,
    `transcript: ${clip.transcript}`,
  ].join('\n');
}

export async function refineClipMetadata(
  request: ClipMetadataRequest,
): Promise<ClipMetadataResult> {
  const passthrough: ClipMetadataResult = {
    clips: request.clips,
    refinedCount: 0,
    warnings: [],
  };

  if (request.clips.length === 0) return passthrough;
  if (!isAgentActive('clip_metadata', request.overrides)) return passthrough;

  const batches = chunk(request.clips, Math.max(1, config.ai.batchSize));
  const warnings: string[] = [];

  const results = await mapWithConcurrency(batches, config.ai.concurrency, async (batch) => {
    try {
      const { data } = await runJsonAgent({
        role: 'clip_metadata',
        system: SYSTEM_PROMPT,
        user: `Episode: ${request.episodeTitle}\n\nClips:\n\n${batch
          .map(describeClip)
          .join('\n\n---\n\n')}`,
        parse: (value) => MetadataSchema.parse(value),
        overrides: request.overrides,
        ledger: request.ledger,
        signal: request.signal,
      });
      return { clips: data.clips, error: null as string | null };
    } catch (error) {
      return {
        clips: [],
        error: error instanceof Error ? error.message : 'unknown metadata error',
      };
    }
  });

  const refinements = new Map<number, (typeof results)[number]['clips'][number]>();

  for (const result of results) {
    if (result.error) {
      warnings.push(`Clip metadata batch failed, keeping draft copy: ${result.error}`);
      continue;
    }
    for (const clip of result.clips) {
      refinements.set(clip.index, clip);
    }
  }

  let refinedCount = 0;
  const clips = request.clips.map((clip) => {
    const refinement = refinements.get(clip.segmentIndex);
    if (!refinement) return clip;

    refinedCount += 1;
    return {
      ...clip,
      title: refinement.title.trim(),
      category: refinement.category ? coerceCategory(refinement.category) : clip.category,
      suggestedHook: refinement.suggestedHook.trim(),
      suggestedCaption: refinement.suggestedCaption.trim(),
      editingNotes: refinement.editingNotes.trim(),
    };
  });

  return { clips, refinedCount, warnings };
}
