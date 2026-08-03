import { getClip } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { badRequest, notFound, ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/episodes/clip-transcript?clipId=...
 *
 * Phase 2 (brief §22) — return the transcript cues inside a clip's window
 * for the timeline editor.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const clipIdRaw = url.searchParams.get('clipId');
  const clipId = clipIdRaw ? Number.parseInt(clipIdRaw, 10) : NaN;
  if (!Number.isFinite(clipId)) return badRequest('Missing valid clipId query param');

  const clip = getClip(clipId);
  if (!clip) return notFound('Clip not found');

  const transcript = getTranscript(clip.videoId);
  const cues = (transcript?.cues ?? []).filter(
    (cue) => cue.startSec >= clip.startSec - 5 && cue.startSec < clip.endSec + 5,
  );

  return ok({
    videoId: clip.videoId,
    language: transcript?.language ?? null,
    cues,
  });
}
