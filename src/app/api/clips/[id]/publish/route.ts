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
 * title becomes the upload title, plus description and tags. Requires:
 *   - render_status = 'done'   (a rendered short exists)
 *   - seo_title present        (SEO was generated)
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

    // Guards: nothing to upload without a render, and no metadata to post.
    if (clip.renderStatus !== 'done' || !clip.renderPath) {
      return badRequest('Clip must be rendered before publishing');
    }
    if (!clip.seoTitle) {
      return badRequest('Generate SEO metadata before publishing (POST /api/clips/:id/seo)');
    }
    if (clip.publishStatus === 'publishing') {
      return badRequest('Publish already in progress');
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
