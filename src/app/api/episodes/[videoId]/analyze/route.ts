import { config } from '@/lib/config';
import {
  episodeRecordToCandidate,
  getEpisode,
  markEpisodeAnalysed,
  markEpisodeFailed,
} from '@/lib/db/repositories/episodes';
import { replaceClipsForEpisode } from '@/lib/db/repositories/clips';
import { analyzeEpisode } from '@/lib/pipeline/analyze-episode';
import { UsageLedger, type AgentOverrides } from '@/lib/ai';
import { notFound, ok, parseJsonBody, serverError } from '@/lib/api/http';
import { analyzeEpisodeSchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

/**
 * POST /api/episodes/:videoId/analyze
 *
 * Re-run Steps 3-8 for one episode, bypassing discovery and the opportunity
 * gate. Two real uses:
 *  - the scoring model changed and this episode's clips need re-scoring
 *  - the episode was skipped by the gate but the user wants it analysed anyway
 */
export async function POST(request: Request, context: RouteContext) {
  const { videoId } = await context.params;

  const { data, error } = await parseJsonBody(request, analyzeEpisodeSchema);
  if (error) return error;

  try {
    const record = getEpisode(videoId);
    if (!record) return notFound('Episode not found');

    const ledger = new UsageLedger();

    try {
      const analysis = await analyzeEpisode({
        candidate: episodeRecordToCandidate(record),
        topic: record.topic,
        clipScoreThreshold: data.clipScoreThreshold ?? config.pipeline.clipScoreThreshold,
        forceTranscriptRefresh: data.forceTranscriptRefresh,
        overrides: data.agents as AgentOverrides | undefined,
        ledger,
      });

      replaceClipsForEpisode(videoId, analysis.allClips, record.lastRunId);
      markEpisodeAnalysed({
        videoId,
        transcriptSource: analysis.transcript.source,
        segmentCount: analysis.segments.length,
        clipCount: analysis.clips.length,
      });

      const usage = ledger.summary();

      return ok({
        episode: getEpisode(videoId),
        clips: analysis.clips,
        segmentCount: analysis.segments.length,
        transcriptSource: analysis.transcript.source,
        engine: analysis.engine,
        aiUsage: {
          calls: usage.calls,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
        warnings: analysis.warnings,
      });
    } catch (analysisError) {
      const message =
        analysisError instanceof Error ? analysisError.message : 'Unknown analysis error';
      markEpisodeFailed(videoId, message);
      throw analysisError;
    }
  } catch (error) {
    return serverError(error);
  }
}
