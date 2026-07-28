import { getEpisode } from '@/lib/db/repositories/episodes';
import { listClips } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { notFound, ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

/** GET /api/episodes/:videoId - episode, its clips, and transcript availability. */
export async function GET(_request: Request, context: RouteContext) {
  const { videoId } = await context.params;

  try {
    const episode = getEpisode(videoId);
    if (!episode) return notFound('Episode not found');

    const transcript = getTranscript(videoId);

    return ok({
      episode,
      clips: listClips({ videoId, sort: 'score', limit: 200 }),
      transcript: transcript
        ? {
            source: transcript.source,
            language: transcript.language,
            wordCount: transcript.wordCount,
            durationSec: transcript.durationSec,
            cueCount: transcript.cues.length,
          }
        : null,
    });
  } catch (error) {
    return serverError(error);
  }
}
