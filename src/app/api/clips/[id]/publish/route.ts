import { config } from '@/lib/config';
import { getClip, updateClipPublish } from '@/lib/db/repositories/clips';
import { badRequest, notFound, ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/clips/:id/publish
 *
 * Phase 3 — publish a rendered short to YouTube (and later TikTok/Reels).
 *
 * Uses the SEO metadata already generated for the clip: the first generated
 * title becomes the upload title, plus description and tags.
 *
 * Phase 2 publish gates (Master Task Brief §24): publish is BLOCKED when:
 *   - render not completed            (renderStatus !== 'done')
 *   - QC failed                       (qc_status !== 'passed')
 *   - boundary not refined            (boundary_status === 'unrefined')
 *   - ending incomplete               (ending_complete = 0)
 *   - next-topic contamination too high
 *   - rights not approved             (rights_status === 'unknown'/'blocked')
 *   - SEO metadata absent             (no seo_title)
 *   - publish already in progress
 *
 * Env toggles (brief §38):
 *   PUBLISH_REQUIRE_QC_PASS=true
 *   PUBLISH_REQUIRE_BOUNDARY_PASS=true
 *   PUBLISH_REQUIRE_RIGHTS_APPROVAL=true
 *
 * The actual upload is delegated to the poster service, which owns the
 * platform OAuth credentials.
 *
 * Response: { clip: { publishStatus, publishUrl, publishError }, url }
 */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const clipId = Number.parseInt(id, 10);

  if (!Number.isFinite(clipId)) return badRequest('Clip id must be numeric');

  try {
    const clip = getClip(clipId);
    if (!clip) return notFound('Clip not found');

    // ── Phase 2 publish gates (brief §24) ──
    // Render completed?
    if (clip.renderStatus !== 'done' || !clip.renderPath) {
      return badRequest('Clip must be rendered before publishing');
    }
    // Publish already in progress?
    if (clip.publishStatus === 'publishing') {
      return badRequest('Publish already in progress');
    }
    // SEO metadata present?
    if (!clip.seoTitle) {
      return badRequest('Generate SEO metadata before publishing (POST /api/clips/:id/seo)');
    }

    const gates = {
      qc: config.publish.requireQcPass !== false,
      boundary: config.publish.requireBoundaryPass !== false,
      rights: config.publish.requireRightsApproval !== false,
    };

    // QC gate: renderer QC must have passed (qc_status === 'passed').
    if (gates.qc && clip.qcStatus !== 'passed') {
      const state = clip.qcStatus ?? 'pending';
      const score = clip.qcScore != null ? ` (${Math.round(clip.qcScore)})` : '';
      return badRequest(`Publish blocked: QC ${state}${score}. Run render again or override QC (POST /api/clips/:id/qc/override).`);
    }

    // Boundary gate: clips must have refined boundaries and complete endings.
    if (gates.boundary) {
      if (clip.boundaryStatus === 'unrefined' || clip.boundaryStatus == null) {
        return badRequest('Publish blocked: boundary not refined. Re-run analyze (POST /api/episodes/:videoId/analyze).');
      }
      if (clip.endingComplete === false) {
        return badRequest('Publish blocked: ending incomplete.');
      }
      const maxContamination = 0.18;
      if (clip.nextTopicContamination != null && clip.nextTopicContamination > maxContamination) {
        return badRequest(`Publish blocked: next-topic contamination ${clip.nextTopicContamination.toFixed(2)} > ${maxContamination}.`);
      }
    }

    // Rights gate: only clips with approved rights may be published.
    if (gates.rights) {
      const blockedRights = new Set(['unknown', 'blocked', 'editorial_review_required']);
      if (!clip.rightsStatus || blockedRights.has(clip.rightsStatus)) {
        return badRequest(`Publish blocked: rights status '${clip.rightsStatus ?? 'unknown'}'. Approve rights first (POST /api/clips/:id/rights).`);
      }
    }

    // Render file URL reachable from the poster service. The poster service
    // runs on the HOST (not in Docker), so it must use the host loopback —
    // host.docker.internal only resolves inside the container network.
    const renderBase = 'http://127.0.0.1:8084';
    const fileUrl = `${renderBase}/files/${clip.renderPath}`;
    // Phase 7 integration: if the render job also produced a thumbnail, send
    // it along so YouTube gets a custom thumbnail, not a random frame.
    const jobId = clip.renderPath?.split('/')[0];
    const thumbnailUrl = jobId ? `${renderBase}/files/${jobId}/thumbnail.jpg` : '';

    // Mark publishing before the long call so a concurrent GET sees intent.
    updateClipPublish(clipId, { status: 'publishing' });

    const publishBase = config.publish.baseUrl.replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.publish.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${publishBase}/api/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.publish.token ? { 'x-poster-token': config.publish.token } : {}),
        },
        body: JSON.stringify({
          clip_id: clip.id,
          title: clip.seoTitle,
          description: clip.seoDescription ?? '',
          tags: clip.seoTags,
          file_url: fileUrl,
          thumbnail_url: thumbnailUrl,
          privacy: config.publish.privacy,
        }),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error && fetchErr.name === 'AbortError'
        ? 'Publish timed out'
        : `Poster service unreachable: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`;
      updateClipPublish(clipId, { status: 'error', error: msg });
      return serverError(msg);
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => null)) as
      | { detail?: string; url?: string; status?: string; videoId?: string }
      | null;

    if (!response.ok) {
      const msg = body?.detail ?? `Publish failed with ${response.status}`;
      updateClipPublish(clipId, { status: 'error', error: msg });
      return serverError(msg);
    }

    updateClipPublish(clipId, {
      status: 'published',
      url: body?.url ?? null,
      error: null,
    });

    const updated = getClip(clipId);
    return ok({
      clip: {
        publishStatus: updated?.publishStatus ?? 'published',
        publishUrl: updated?.publishUrl ?? null,
        publishError: updated?.publishError ?? null,
      },
      url: body?.url ?? null,
      videoId: body?.videoId ?? null,
    });
  } catch (err) {
    console.error('[publish] failed', err);
    updateClipPublish(clipId, { status: 'error', error: err instanceof Error ? err.message : 'publish failed' });
    return serverError('Publish failed');
  }
}
