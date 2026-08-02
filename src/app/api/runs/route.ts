import { listRuns } from '@/lib/db/repositories/runs';
import { runPipeline } from '@/lib/pipeline/orchestrator';
import { ok, parseJsonBody, serverError } from '@/lib/api/http';
import { runRequestSchema } from '@/lib/api/schemas';
import type { AgentOverrides } from '@/lib/ai';

export const dynamic = 'force-dynamic';
/**
 * Analysis is long-running. A three episode run with an LLM scoring agent can
 * take a couple of minutes, so the route needs a generous ceiling.
 */
export const maxDuration = 300;

/** GET /api/runs - recent pipeline runs. */
export function GET() {
  try {
    return ok({ runs: listRuns(25) });
  } catch (error) {
    return serverError(error);
  }
}

/**
 * POST /api/runs - execute the full pipeline.
 *
 * Body accepts a per-role agent override map, so a caller can run discovery on
 * a cheap fast model and clip scoring on a frontier model in the same request:
 *
 *   {
 *     "mode": "topic",
 *     "topic": "artificial intelligence",
 *     "agents": {
 *       "discovery":    { "provider": "groq" },
 *       "clip_scoring": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
 *     }
 *   }
 */
export async function POST(request: Request) {
  const { data, error } = await parseJsonBody(request, runRequestSchema);
  if (error) return error;

  try {
    const summary = await runPipeline({
      mode: data.mode,
      topic: data.topic,
      channelIds: data.channelIds,
      maxEpisodes: data.maxEpisodes,
      episodeScoreThreshold: data.episodeScoreThreshold,
      clipScoreThreshold: data.clipScoreThreshold,
      publishedWithinDays: data.publishedWithinDays,
      force: data.force,
      overrides: data.agents as AgentOverrides | undefined,
    });

    // Optional Phase 8+ flow: automatically push every qualifying clip
    // (non-archive tier from analysed episodes) through render → SEO →
    // publish. Fire-and-forget so the run response returns immediately;
    // progress is visible in the UI via the per-clip render/SEO/publish
    // status fields.
    if (data.autoProcess) {
      const { autoProcessRun } = await import('@/lib/pipeline/auto-process');
      void autoProcessRun(summary.runId).catch((err) => {
        console.error('[auto-process] background job failed:', err);
      });
      console.log(`[api] auto-process triggered for run ${summary.runId}`);
    }

    return ok(summary, { status: 201 });
  } catch (error) {
    return serverError(error);
  }
}
