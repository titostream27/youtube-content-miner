import {
  addTrackedChannel,
  listTrackedChannels,
  removeTrackedChannel,
  upsertChannel,
} from '@/lib/db/repositories/channels';
import { resolveChannel, suggestedChannels } from '@/lib/youtube/discovery';
import { badRequest, notFound, ok, parseJsonBody, serverError } from '@/lib/api/http';
import { trackChannelSchema } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

/** GET /api/channels/tracked - PRD Mode B watch list. */
export function GET() {
  try {
    return ok({
      tracked: listTrackedChannels(false),
      suggestions: suggestedChannels(),
    });
  } catch (error) {
    return serverError(error);
  }
}

/**
 * POST /api/channels/tracked
 *
 * Accepts anything a user is likely to paste - a channel ID, a channel URL, an
 * @handle, or just the show's name - and resolves it before storing, so the
 * watch list always holds real channel IDs.
 */
export async function POST(request: Request) {
  const { data, error } = await parseJsonBody(request, trackChannelSchema);
  if (error) return error;

  try {
    const resolved = await resolveChannel(data.query);
    if (!resolved) {
      return notFound(`Could not resolve a channel from "${data.query}"`);
    }

    upsertChannel(resolved.channel);
    addTrackedChannel(resolved.channel.channelId, data.label ?? resolved.channel.title);

    return ok(
      {
        channel: resolved.channel,
        matchedBy: resolved.matchedBy,
        tracked: listTrackedChannels(false),
      },
      { status: 201 },
    );
  } catch (error) {
    return serverError(error);
  }
}

/** DELETE /api/channels/tracked?channelId=... */
export function DELETE(request: Request) {
  const channelId = new URL(request.url).searchParams.get('channelId');
  if (!channelId) return badRequest('channelId query parameter is required');

  try {
    removeTrackedChannel(channelId);
    return ok({ tracked: listTrackedChannels(false) });
  } catch (error) {
    return serverError(error);
  }
}
