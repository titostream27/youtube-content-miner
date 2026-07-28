import { listClips } from '@/lib/db/repositories/clips';
import { exportDescriptor, exportFilename, renderExport } from '@/lib/export';
import { parseSearchParams, serverError } from '@/lib/api/http';
import { toClipFilters } from '@/lib/api/filters';
import { exportQuerySchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

/**
 * GET /api/export?format=csv|txt
 *
 * Accepts the same filters as `/api/clips`, so the export always matches the
 * view the user was looking at.
 *
 *   /api/export?format=csv&tier=publish_immediately
 *   /api/export?format=txt&videoId=abc123
 */
export function GET(request: Request) {
  const { data, error } = parseSearchParams(request.url, exportQuerySchema);
  if (error) return error;

  try {
    const filters = toClipFilters(data);
    // Exports are a handoff document, not a paginated view.
    const clips = listClips({ ...filters, limit: filters.limit ?? 500 });

    const descriptor = exportDescriptor(data.format);
    const scope = data.videoId ?? data.tier?.toString() ?? data.channelId ?? 'library';
    const filename = exportFilename(data.format, String(scope));

    return new Response(renderExport(data.format, clips), {
      headers: {
        'content-type': descriptor.contentType,
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
