import { listRenderJobs } from '@/lib/db/repositories/render-jobs';
import { ok } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/render-jobs
 * Phase 2 (brief §19/§39) — list recent async render jobs.
 */
export async function GET() {
  const jobs = listRenderJobs(50);
  return ok({
    jobs: jobs.map((j) => ({
      jobId: j.jobId,
      episodeId: j.episodeId,
      mode: j.mode,
      status: j.status,
      error: j.error,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    })),
  });
}
