import { getClip, updateClipBoundary } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { cuesToUtterances, sliceTranscriptForRange } from '@/lib/moments/utterances';
import {
  classifyEnding,
  detectTopicBoundary,
} from '@/lib/moments/topic-boundary';
import { repairBoundary } from '@/lib/moments/boundary-repair';
import { config } from '@/lib/config';
import { badRequest, notFound, ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function utteranceAtOrBefore(utterances: ReturnType<typeof cuesToUtterances>, sec: number): number {
  for (let i = utterances.length - 1; i >= 0; i -= 1) {
    if (utterances[i]!.endSec <= sec + 0.05) return i;
  }
  return -1;
}

/**
 * POST /api/clips/:id/refine-boundary
 *
 * Phase 2 (Master Task Brief §12/§39) — re-run deterministic boundary
 * refinement for a single clip (snap to last complete ending, cut before
 * next topic, repair if needed). Persists the improved boundary.
 */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  try {
    const clip = getClip(clipId);
    if (!clip) return notFound('Clip not found');

    const transcript = getTranscript(clip.videoId);
    const roughWindowStart = clip.roughStartSec ?? clip.startSec - 5;
    const cues = (transcript?.cues ?? []).filter((cue) => cue.startSec >= roughWindowStart);
    const utterances = cuesToUtterances(cues);

    if (utterances.length === 0) {
      return ok({ clipId, message: 'no utterances to refine', startSec: clip.startSec, endSec: clip.endSec });
    }

    const roughStart = clip.roughStartSec ?? clip.startSec;
    const roughEnd = clip.roughEndSec ?? clip.endSec;

    // Deterministic guard pass (same logic as two-pass.ts).
    const endIdx = utteranceAtOrBefore(utterances, clip.endSec);
    const endUtterance = endIdx >= 0 ? utterances[endIdx]! : null;
    const nextUtterance = endIdx >= 0 && endIdx + 1 < utterances.length ? utterances[endIdx + 1]! : null;
    const following = endIdx >= 0 ? utterances.slice(endIdx + 1, endIdx + 4) : [];

    let finalStart = clip.startSec;
    let finalEnd = clip.endSec;
    let boundaryStatus = 'refined';
    let repairReason: string | null = null;

    if (endUtterance) {
      const ending = classifyEnding(endUtterance, nextUtterance, following);
      const boundary = detectTopicBoundary(
        endUtterance,
        nextUtterance,
        following,
        config.pipeline.highlight.nextTopicLookaheadSec,
      );

      if (!ending.endingComplete || boundary.nextTopicDetected) {
        const repair = repairBoundary(
          utterances,
          { roughStartSec: roughStart, roughEndSec: roughEnd },
          boundary.nextTopicStart !== null
            ? boundary.nextTopicStart - config.pipeline.highlight.endGuardSec
            : roughEnd,
        );
        if (repair.boundaryStatus === 'repaired' || repair.boundaryStatus === 'refined') {
          finalStart = repair.finalStartSec;
          finalEnd = repair.finalEndSec;
          boundaryStatus = repair.boundaryStatus;
          repairReason = repair.repairReason ?? null;
        }
      }
    }

    updateClipBoundary(clipId, {
      startSec: Math.round(finalStart * 100) / 100,
      endSec: Math.round(finalEnd * 100) / 100,
      durationSec: Math.round((finalEnd - finalStart) * 100) / 100,
      boundaryStatus,
      repairReason,
      // Phase 2 (Intelligence correctness): re-slice transcript text to the
      // final boundary so scoring/captions describe the rendered window.
      ...(finalStart !== clip.startSec || finalEnd !== clip.endSec
        ? (() => {
            const s = sliceTranscriptForRange(utterances, finalStart, finalEnd);
            return { transcript: s.text, wordCount: s.wordCount };
          })()
        : {}),
    });

    return ok({
      clipId,
      boundaryStatus,
      repairReason,
      startSec: Math.round(finalStart * 100) / 100,
      endSec: Math.round(finalEnd * 100) / 100,
      message: boundaryStatus === 'repaired' ? 'Boundary repaired to last complete ending' : 'Boundary already acceptable',
    });
  } catch (e) {
    return serverError(e);
  }
}
