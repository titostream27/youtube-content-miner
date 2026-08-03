import { getClip } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { listBoundaryFeedback } from '@/lib/db/repositories/feedback';
import { badRequest, notFound, ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/clips/:id/boundary-report
 *
 * Phase 1 (Master Task Brief §13/§39) — structured boundary debug report:
 *   rough/final boundaries, narrative topics, ending classification,
 *   next-topic info, boundary status, and manual feedback history.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  const transcript = getTranscript(clip.videoId);
  const cueCount = (transcript?.cues ?? []).filter(
    (cue) => cue.startSec >= clip.startSec && cue.startSec < clip.endSec,
  ).length;

  const feedback = listBoundaryFeedback(clipId);

  return ok({
    candidate_id: `candidate-${clip.segmentIndex}`,
    clip_id: clip.id,
    rough_start_sec: clip.roughStartSec ?? clip.startSec,
    rough_end_sec: clip.roughEndSec ?? clip.endSec,
    final_start_sec: clip.startSec,
    final_end_sec: clip.endSec,
    duration_sec: clip.durationSec,

    topic_before: clip.topicBefore,
    main_topic: clip.mainTopic,
    topic_after: clip.topicAfter,

    ending_type: clip.endingType,
    ending_complete: clip.endingComplete,
    ending_confidence: clip.endingConfidence,
    boundary_confidence: clip.boundaryConfidence,
    boundary_status: clip.boundaryStatus,

    next_topic_start_sec: clip.nextTopicStartSec,
    next_topic_removed_sec:
      clip.nextTopicStartSec !== null ? Math.round((clip.nextTopicStartSec - clip.endSec) * 100) / 100 : null,
    next_topic_contamination: clip.nextTopicContamination,

    cue_count_in_window: cueCount,
    feedback_count: feedback.length,
    feedback: feedback.slice(0, 10).map((f) => ({
      id: f.id,
      original_start_sec: f.originalStartSec,
      original_end_sec: f.originalEndSec,
      new_start_sec: f.newStartSec,
      new_end_sec: f.newEndSec,
      reason: f.reason,
    })),

    warnings:
      clip.endingComplete === false
        ? ['ending incomplete']
        : clip.nextTopicContamination != null && clip.nextTopicContamination > 0.18
          ? ['next-topic contamination too high']
          : [],
  });
}
