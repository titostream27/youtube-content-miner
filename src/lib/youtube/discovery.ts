import { config } from '@/lib/config';
import type { ChannelSummary, EpisodeCandidate } from '@/lib/domain/types';
import { parseIsoDuration } from './duration';
import {
  bestThumbnail,
  listChannelUploads,
  listChannels,
  listTrendingVideos,
  listVideos,
  searchChannels,
  searchVideos,
  toNumber,
  YouTubeApiError,
  type ChannelItem,
  type VideoItem,
} from './client';
import {
  getFixtureChannel,
  listFixtureChannelEpisodes,
  listFixtureChannels,
  searchFixtureEpisodes,
} from './fixtures';

/**
 * PRD Step 1 - AI Podcast Discovery.
 *
 * The user never supplies a YouTube URL. They type a topic, or they name
 * channels to watch, and this module produces episode candidates.
 *
 * Live and demo paths return the identical `EpisodeCandidate[]` shape, so
 * everything downstream - opportunity scoring, transcript extraction, the
 * pipeline, the UI - is completely unaware of which one it is running against.
 */

export interface DiscoveryOutcome {
  candidates: EpisodeCandidate[];
  warnings: string[];
  source: 'live' | 'demo';
}

function channelItemToSummary(item: ChannelItem): ChannelSummary {
  return {
    channelId: item.id,
    title: item.snippet.title,
    handle: item.snippet.customUrl ?? null,
    thumbnailUrl: bestThumbnail(item.snippet.thumbnails),
    subscriberCount: item.statistics?.hiddenSubscriberCount
      ? null
      : toNumber(item.statistics?.subscriberCount) || null,
    videoCount: toNumber(item.statistics?.videoCount) || null,
    viewCount: toNumber(item.statistics?.viewCount) || null,
  };
}

function videoItemToCandidate(
  item: VideoItem,
  channels: Map<string, ChannelSummary>,
): EpisodeCandidate {
  return {
    videoId: item.id,
    title: item.snippet.title,
    description: item.snippet.description ?? '',
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    viewCount: toNumber(item.statistics?.viewCount),
    likeCount: toNumber(item.statistics?.likeCount),
    commentCount: toNumber(item.statistics?.commentCount),
    thumbnailUrl: bestThumbnail(item.snippet.thumbnails),
    tags: item.snippet.tags ?? [],
    // `contentDetails.caption` is the only caption signal available without
    // spending 50 quota units on captions.list.
    hasCaptions: item.contentDetails?.caption === undefined
      ? null
      : item.contentDetails.caption === 'true',
    license:
      item.status?.license === 'creativeCommon'
        ? 'creativeCommon'
        : item.status?.license === 'youtube'
          ? 'youtube'
          : null,
    embeddable: item.status?.embeddable ?? null,
    channel: channels.get(item.snippet.channelId) ?? null,
  };
}

/** Hydrate video IDs into full candidates, including channel statistics. */
async function hydrateVideos(videoIds: string[]): Promise<EpisodeCandidate[]> {
  const unique = Array.from(new Set(videoIds));
  if (unique.length === 0) return [];

  const videos = await listVideos(unique);
  if (videos.length === 0) return [];

  const channelIds = Array.from(new Set(videos.map((video) => video.snippet.channelId)));
  const channelItems = await listChannels(channelIds);
  const channelMap = new Map<string, ChannelSummary>(
    channelItems.map((item) => [item.id, channelItemToSummary(item)]),
  );

  return videos.map((video) => videoItemToCandidate(video, channelMap));
}

function describeApiFailure(error: unknown): string {
  if (error instanceof YouTubeApiError) {
    return error.isQuotaExceeded
      ? 'YouTube API daily quota exhausted. Falling back to the demo catalogue.'
      : `YouTube API error: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Unknown YouTube API error';
}

/* -------------------------------------------------------------------------- */
/* Mode A - search by topic                                                   */
/* -------------------------------------------------------------------------- */

export async function discoverByTopic(params: {
  topic: string;
  maxResults: number;
  publishedWithinDays?: number;
}): Promise<DiscoveryOutcome> {
  const { topic, maxResults, publishedWithinDays } = params;

  if (config.youtube.demoMode) {
    return {
      candidates: searchFixtureEpisodes({ topic, maxResults, publishedWithinDays }),
      warnings: [
        'Demo catalogue in use - set YOUTUBE_API_KEY for live discovery.',
      ],
      source: 'demo',
    };
  }

  const publishedAfter =
    typeof publishedWithinDays === 'number'
      ? new Date(Date.now() - publishedWithinDays * 86_400_000).toISOString()
      : undefined;

  try {
    // Over-fetch: search returns Shorts compilations and re-uploads that the
    // opportunity score will discard, so we need headroom above `maxResults`.
    const { items } = await searchVideos({
      query: topic,
      maxResults: Math.min(50, Math.max(maxResults * 2, 10)),
      publishedAfter,
      order: 'relevance',
    });

    const videoIds = items
      .map((item) => item.id.videoId)
      .filter((videoId): videoId is string => Boolean(videoId));

    const candidates = await hydrateVideos(videoIds);
    return { candidates, warnings: [], source: 'live' };
  } catch (error) {
    return {
      candidates: searchFixtureEpisodes({ topic, maxResults, publishedWithinDays }),
      warnings: [describeApiFailure(error)],
      source: 'demo',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Mode B - track channels (recent uploads)                                   */
/* -------------------------------------------------------------------------- */

export async function discoverFromChannels(params: {
  channelIds: string[];
  maxPerChannel: number;
  publishedWithinDays?: number;
}): Promise<DiscoveryOutcome> {
  const { channelIds, maxPerChannel, publishedWithinDays } = params;

  if (channelIds.length === 0) {
    return { candidates: [], warnings: ['No channels are being tracked yet.'], source: 'demo' };
  }

  if (config.youtube.demoMode) {
    const candidates = channelIds.flatMap((channelId) =>
      listFixtureChannelEpisodes({ channelId, maxResults: maxPerChannel, publishedWithinDays }),
    );
    return {
      candidates,
      warnings: ['Demo catalogue in use - set YOUTUBE_API_KEY for live discovery.'],
      source: 'demo',
    };
  }

  const warnings: string[] = [];

  try {
    const channelItems = await listChannels(channelIds);
    const videoIds: string[] = [];

    for (const item of channelItems) {
      const uploads = item.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) {
        warnings.push(`Channel ${item.snippet.title} has no accessible uploads playlist.`);
        continue;
      }
      const ids = await listChannelUploads({
        uploadsPlaylistId: uploads,
        maxResults: maxPerChannel,
      });
      videoIds.push(...ids);
    }

    let candidates = await hydrateVideos(videoIds);

    if (typeof publishedWithinDays === 'number') {
      const cutoff = Date.now() - publishedWithinDays * 86_400_000;
      candidates = candidates.filter(
        (candidate) => new Date(candidate.publishedAt).getTime() >= cutoff,
      );
    }

    return { candidates, warnings, source: 'live' };
  } catch (error) {
    const candidates = channelIds.flatMap((channelId) =>
      listFixtureChannelEpisodes({ channelId, maxResults: maxPerChannel, publishedWithinDays }),
    );
    return { candidates, warnings: [...warnings, describeApiFailure(error)], source: 'demo' };
  }
}

/* -------------------------------------------------------------------------- */
/* Mode T - trending discovery (recent mostPopular videos)                    */
/* -------------------------------------------------------------------------- */

/**
 * Turn today mostPopular YouTube videos into episode candidates. Unlike the
 * other modes these are not necessarily long-form interviews, so short clips
 * and non-embeddable videos are dropped before they reach scoring.
 */
export async function discoverFromTrending(params: {
  regionCode?: string;
  maxResults?: number;
}): Promise<DiscoveryOutcome> {
  const maxResults = params.maxResults ?? 25;

  if (config.youtube.demoMode) {
    const topic = 'trending';
    return {
      candidates: searchFixtureEpisodes({ topic, maxResults }),
      warnings: ['Demo catalogue in use - set YOUTUBE_API_KEY for live discovery.'],
      source: 'demo',
    };
  }

  try {
    const items = await listTrendingVideos({
      regionCode: params.regionCode,
      maxResults,
    });

    // mostPopular contains Shorts, music videos and trailers. Keep only
    // embeddable videos at least a minute long so the episode opportunity
    // score has real long-form material to judge.
    const candidates = items
      .filter((item) => item.status?.embeddable !== false)
      .filter((item) => parseIsoDuration(item.contentDetails?.duration) >= 60);

    if (candidates.length === 0) {
      return { candidates: [], warnings: ['No long-form trending videos found.'], source: 'live' };
    }

    const channelIds = Array.from(new Set(candidates.map((video) => video.snippet.channelId)));
    const channelItems = await listChannels(channelIds);
    const channelMap = new Map<string, ChannelSummary>(
      channelItems.map((item) => [item.id, channelItemToSummary(item)]),
    );

    return {
      candidates: candidates.map((video) => videoVideoItemToCandidate(video, channelMap)),
      warnings: [],
      source: 'live',
    };
  } catch (error) {
    return {
      candidates: searchFixtureEpisodes({ topic: 'trending', maxResults }),
      warnings: [describeApiFailure(error)],
      source: 'demo',
    };
  }
}

/** Convert a fully-hydrated VideoItem (from trending) into an EpisodeCandidate. */
function videoVideoItemToCandidate(
  item: VideoItem,
  channels: Map<string, ChannelSummary>,
): EpisodeCandidate {
  return {
    videoId: item.id,
    title: item.snippet.title,
    description: item.snippet.description ?? '',
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    viewCount: toNumber(item.statistics?.viewCount),
    likeCount: toNumber(item.statistics?.likeCount),
    commentCount: toNumber(item.statistics?.commentCount),
    thumbnailUrl: bestThumbnail(item.snippet.thumbnails),
    tags: item.snippet.tags ?? [],
    hasCaptions: item.contentDetails?.caption === undefined
      ? null
      : item.contentDetails.caption === 'true',
    license:
      item.status?.license === 'creativeCommon'
        ? 'creativeCommon'
        : item.status?.license === 'youtube'
          ? 'youtube'
          : null,
    embeddable: item.status?.embeddable ?? null,
    channel: channels.get(item.snippet.channelId) ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Mode C - archive mining (one channel, whole back catalogue)                 */
/* -------------------------------------------------------------------------- */

export async function mineChannelArchive(params: {
  channelId: string;
  maxResults: number;
}): Promise<DiscoveryOutcome> {
  const { channelId, maxResults } = params;

  if (config.youtube.demoMode) {
    return {
      candidates: listFixtureChannelEpisodes({ channelId, maxResults }),
      warnings: ['Demo catalogue in use - set YOUTUBE_API_KEY for live discovery.'],
      source: 'demo',
    };
  }

  try {
    const [channelItem] = await listChannels([channelId]);
    const uploads = channelItem?.contentDetails?.relatedPlaylists?.uploads;

    if (!uploads) {
      return {
        candidates: [],
        warnings: [`Could not resolve an uploads playlist for channel ${channelId}.`],
        source: 'live',
      };
    }

    const videoIds = await listChannelUploads({ uploadsPlaylistId: uploads, maxResults });
    const candidates = await hydrateVideos(videoIds);
    return { candidates, warnings: [], source: 'live' };
  } catch (error) {
    return {
      candidates: listFixtureChannelEpisodes({ channelId, maxResults }),
      warnings: [describeApiFailure(error)],
      source: 'demo',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Channel resolution                                                         */
/* -------------------------------------------------------------------------- */

const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;

export interface ResolvedChannel {
  channel: ChannelSummary;
  matchedBy: 'id' | 'url' | 'search' | 'demo';
}

/**
 * Accept anything a user is likely to paste: a raw channel ID, a channel URL,
 * an @handle, or just the show's name.
 */
export async function resolveChannel(input: string): Promise<ResolvedChannel | null> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (config.youtube.demoMode) {
    const direct = getFixtureChannel(trimmed);
    if (direct) return { channel: direct, matchedBy: 'demo' };

    const lower = trimmed.toLowerCase().replace(/^@/, '');
    const match = listFixtureChannels().find(
      (channel) =>
        channel.title.toLowerCase().includes(lower) ||
        (channel.handle ?? '').toLowerCase().replace(/^@/, '').includes(lower),
    );
    return match ? { channel: match, matchedBy: 'demo' } : null;
  }

  // Raw channel ID.
  if (CHANNEL_ID_PATTERN.test(trimmed)) {
    const [item] = await listChannels([trimmed]);
    return item ? { channel: channelItemToSummary(item), matchedBy: 'id' } : null;
  }

  // Channel URL containing an ID.
  const urlIdMatch = /youtube\.com\/channel\/(UC[\w-]{22})/.exec(trimmed);
  if (urlIdMatch?.[1]) {
    const [item] = await listChannels([urlIdMatch[1]]);
    return item ? { channel: channelItemToSummary(item), matchedBy: 'url' } : null;
  }

  // Handle or free text. `search.list` is the only public way to resolve a
  // handle to an ID, and it costs 100 quota units, so we do it once and the
  // caller persists the result.
  const handleMatch = /youtube\.com\/(@[\w.-]+)/.exec(trimmed);
  const query = handleMatch?.[1] ?? trimmed;

  const results = await searchChannels(query, 1);
  const channelId = results[0]?.id.channelId ?? results[0]?.snippet.channelId;
  if (!channelId) return null;

  const [item] = await listChannels([channelId]);
  return item ? { channel: channelItemToSummary(item), matchedBy: 'search' } : null;
}

/** Channels available for the discovery UI to suggest. */
export function suggestedChannels(): ChannelSummary[] {
  return config.youtube.demoMode ? listFixtureChannels() : [];
}
