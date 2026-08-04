import { config } from '@/lib/config';

export type JobProbe =
  | { ok: true; state: string }
  | { ok: false; gone: boolean; reason?: string };

/**
 * Probe the render service for a job's liveness.
 *
 * Returns:
 *  - { ok: true, state }  when the render service responded (job exists,
 *    whatever its state).
 *  - { ok: false, gone: true }   when the job no longer exists (HTTP 404).
 *    This happens when the render service was restarted mid-job: the in-memory
 *    _async_jobs map is reset, so a queued/running clip would otherwise be
 *    frozen in renderStatus='rendering' forever, blocking re-renders with
 *    "Clip render already in progress".
 *  - { ok: false, gone: false }  when the render service was unreachable or
 *    timed out. This is NOT treated as "gone" — the service may just be busy
 *    or momentarily down, and we should not clear a job we cannot confirm
 *    is stale.
 *
 * All probes carry a short timeout so they never block the route for long.
 */
export async function probeRenderJob(jobId: string | null | undefined): Promise<JobProbe> {
  if (!jobId) return { ok: false, gone: false, reason: 'no job id stored' };

  const renderBase = config.render.baseUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${renderBase}/api/render/status/${jobId}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) {
      return { ok: false, gone: true, reason: `job ${jobId} not found (service restarted?)` };
    }
    if (!res.ok) {
      return { ok: false, gone: false, reason: `render service ${res.status}` };
    }
    const body = (await res.json()) as { state?: string };
    const state = body.state ?? 'unknown';
    // Terminal-dead states mean the job will never produce output: 'orphaned'
    // is set by the render service when it finds a queued/running job in its
    // persisted store after a restart (the worker thread is gone). 'failed'
    // and 'cancelled' are likewise dead. Treat all of them as gone so the
    // caller's self-heal clears renderStatus and allows a fresh render.
    if (state === 'orphaned' || state === 'failed' || state === 'cancelled') {
      return { ok: false, gone: true, reason: `job ${jobId} is ${state}` };
    }
    return { ok: true, state };
  } catch (e) {
    return {
      ok: false,
      gone: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}