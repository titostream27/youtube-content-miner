import { config } from '@/lib/config';

/**
 * Minimal YouTube Data API v3 client.
 *
 * Quota is the binding constraint on this product, not latency. The default
 * daily allowance is 10,000 units and a single `search.list` call costs 100 of
 * them, so every call site goes through here and every call is metered. The
 * running total is exposed so the UI can warn the user before they burn a day's
 * quota on one discovery run.
 */

export class YouTubeApiError extends Error {
  readonly status: number;
  readonly reason: string | null;

  constructor(message: string, status: number, reason: string | null = null) {
    super(message);
    this.name = 'YouTubeApiError';
    this.status = status;
    this.reason = reason;
  }

  /** True when the failure is a hard quota stop rather than a transient error. */
  get isQuotaExceeded(): boolean {
    return (
      this.reason === 'quotaExceeded' ||
      this.reason === 'dailyLimitExceeded' ||
      // Google returns rateLimitExceeded for the search quota wall too.
      this.reason === 'rateLimitExceeded'
    );
  }
}

export class YouTubeNotConfiguredError extends Error {
  constructor() {
    super('YOUTUBE_API_KEY is not set. Set it in .env.local or run in demo mode.');
    this.name = 'YouTubeNotConfiguredError';
  }
}

/** Documented quota cost per endpoint, in units. */
const QUOTA_COST: Record<string, number> = {
  search: 100,
  videos: 1,
  channels: 1,
  playlistItems: 1,
  captions: 50,
};

let quotaUsedThisProcess = 0;

export function getQuotaUsed(): number {
  return quotaUsedThisProcess;
}

export function resetQuotaCounter(): void {
  quotaUsedThisProcess = 0;
}

const API_BASE = 'https://www.googleapis.com/youtube/v3';

async function request<T>(
  endpoint: keyof typeof QUOTA_COST,
  params: Record<string, string | number | undefined>,
): Promise<T> {
  const keys = config.youtube.apiKeys.length > 0 ? config.youtube.apiKeys : config.youtube.apiKey ? [config.youtube.apiKey] : [];
  if (keys.length === 0) throw new YouTubeNotConfiguredError();

  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError: unknown = null;

  // Rotate through API keys on quota-exceeded so total daily quota scales
  // with the number of configured keys instead of stopping the whole run.
  for (const apiKey of keys) {
    url.searchParams.set('key', apiKey);

    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      // Discovery results change constantly; never serve a stale cache.
      cache: 'no-store',
    });

    quotaUsedThisProcess += QUOTA_COST[endpoint] ?? 1;

    if (response.ok) {
      return (await response.json()) as T;
    }

    let reason: string | null = null;
    let message = `YouTube API ${endpoint} failed with ${response.status}`;

    try {
      const body = (await response.json()) as {
        error?: { message?: string; errors?: { reason?: string }[] };
      };
      reason = body.error?.errors?.[0]?.reason ?? null;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body; keep the generic message.
    }

    const quotaExhausted =
      response.status === 429 &&
      (reason === 'quotaExceeded' ||
        reason === 'dailyLimitExceeded' ||
        reason === 'rateLimitExceeded');

    // Quota exhausted on this key — try the next one. Any other error is
    // not key-specific, so surface it immediately.
    if (!quotaExhausted) {
      throw new YouTubeApiError(message, response.status, reason);
    }

    lastError = new YouTubeApiError(message, response.status, reason);
  }

  throw lastError instanceof Error
    ? lastError
    : new YouTubeApiError('YouTube API quota exhausted on all configured keys', 429, 'quotaExceeded');
}

/* -------------------------------------------------------------------------- */
/* Response shapes (only the fields we consume)                               */
/* -------------------------------------------------------------------------- */

interface Thumbnails {
  default?: { url: string };
  medium?: { url: string };
  high?: { url: string };
  standard?: { url: string };
  maxres?: { url: string };
}

export interface SearchResultItem {
  id: { kind: string; videoId?: string; channelId?: string };
  snippet: {
    title: string;
    description: string;
    channelId: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails?: Thumbnails;
  };
}

export interface VideoItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    channelId: string;
    channelTitle: string;
    publishedAt: string;
    tags?: string[];
    thumbnails?: Thumbnails;
    defaultAudioLanguage?: string;
  };
  contentDetails: {
    duration: string;
    caption?: string;
  };
  statistics: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
  /** Reuse rights. Requested via the `status` part, which costs no extra quota. */
  status?: {
    license?: string;
    embeddable?: boolean;
    privacyStatus?: string;
  };
}

export interface ChannelItem {
  id: string;
  snippet: {
    title: string;
    customUrl?: string;
    thumbnails?: Thumbnails;
  };
  statistics?: {
    subscriberCount?: string;
    videoCount?: string;
    viewCount?: string;
    hiddenSubscriberCount?: boolean;
  };
  contentDetails?: {
    relatedPlaylists?: { uploads?: string };
  };
}

export interface PlaylistItem {
  contentDetails: { videoId: string; videoPublishedAt?: string };
}

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
  pageInfo?: { totalResults?: number };
}

export function bestThumbnail(thumbnails: Thumbnails | undefined): string | null {
  if (!thumbnails) return null;
  return (
    thumbnails.maxres?.url ??
    thumbnails.standard?.url ??
    thumbnails.high?.url ??
    thumbnails.medium?.url ??
    thumbnails.default?.url ??
    null
  );
}

export function toNumber(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Search for long-form videos matching a query.
 *
 * `videoDuration=long` restricts results to >20 minutes at no extra quota cost,
 * which is by far the cheapest way to filter out Shorts and clip-farm uploads
 * before we pay to hydrate them.
 */
export async function searchVideos(params: {
  query: string;
  maxResults?: number;
  publishedAfter?: string;
  order?: 'relevance' | 'date' | 'viewCount' | 'rating';
  regionCode?: string;
  relevanceLanguage?: string;
  pageToken?: string;
}): Promise<{ items: SearchResultItem[]; nextPageToken: string | null }> {
  const response = await request<ListResponse<SearchResultItem>>('search', {
    part: 'snippet',
    q: params.query,
    type: 'video',
    videoDuration: 'long',
    maxResults: Math.min(50, params.maxResults ?? 25),
    order: params.order ?? 'relevance',
    publishedAfter: params.publishedAfter,
    regionCode: params.regionCode ?? 'US',
    relevanceLanguage: params.relevanceLanguage ?? 'en',
    pageToken: params.pageToken,
  });

  return {
    items: response.items ?? [],
    nextPageToken: response.nextPageToken ?? null,
  };
}

/** Hydrate up to 50 video IDs per call (1 quota unit total). */
export async function listVideos(videoIds: string[]): Promise<VideoItem[]> {
  if (videoIds.length === 0) return [];

  const batches: string[][] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    batches.push(videoIds.slice(i, i + 50));
  }

  const results: VideoItem[] = [];
  for (const batch of batches) {
    const response = await request<ListResponse<VideoItem>>('videos', {
      // `status` carries the licence and embeddable flags. Adding parts to a
      // videos.list call does not increase its 1-unit quota cost.
      part: 'snippet,contentDetails,statistics,status',
      id: batch.join(','),
      maxResults: 50,
    });
    results.push(...(response.items ?? []));
  }

  return results;
}

export async function listChannels(channelIds: string[]): Promise<ChannelItem[]> {
  if (channelIds.length === 0) return [];

  const unique = Array.from(new Set(channelIds));
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += 50) {
    batches.push(unique.slice(i, i + 50));
  }

  const results: ChannelItem[] = [];
  for (const batch of batches) {
    const response = await request<ListResponse<ChannelItem>>('channels', {
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
      maxResults: 50,
    });
    results.push(...(response.items ?? []));
  }

  return results;
}

/**
 * Walk a channel's uploads playlist. This is how Mode C (archive mining) reads
 * an entire back catalogue for 1 quota unit per 50 videos, instead of 100 units
 * per search page.
 */
export async function listChannelUploads(params: {
  uploadsPlaylistId: string;
  maxResults: number;
}): Promise<string[]> {
  const videoIds: string[] = [];
  let pageToken: string | undefined;

  while (videoIds.length < params.maxResults) {
    const response = await request<ListResponse<PlaylistItem>>('playlistItems', {
      part: 'contentDetails',
      playlistId: params.uploadsPlaylistId,
      maxResults: Math.min(50, params.maxResults - videoIds.length),
      pageToken,
    });

    const items = response.items ?? [];
    if (items.length === 0) break;

    videoIds.push(...items.map((item) => item.contentDetails.videoId));

    if (!response.nextPageToken) break;
    pageToken = response.nextPageToken;
  }

  return videoIds.slice(0, params.maxResults);
}

/** Resolve a channel search term (name or handle) to channel IDs. */
export async function searchChannels(query: string, maxResults = 5): Promise<SearchResultItem[]> {
  const response = await request<ListResponse<SearchResultItem>>('search', {
    part: 'snippet',
    q: query,
    type: 'channel',
    maxResults: Math.min(50, maxResults),
  });
  return response.items ?? [];
}

/** Fetch videos from the trending chart for a region.
 * Uses `videos.list` with `chart=mostPopular`, quota cost is only 1 unit (same as other list calls). 
 */
export async function listTrendingVideos(params: {
  regionCode?: string;
  videoCategoryId?: string;
  maxResults?: number;
}): Promise<VideoItem[]> {
  const response = await request<ListResponse<VideoItem>>('videos', {
    part: 'snippet,contentDetails,statistics,status',
    chart: 'mostPopular',
    regionCode: params.regionCode ?? 'ID',
    videoCategoryId: params.videoCategoryId,
    maxResults: Math.min(50, params.maxResults ?? 25),
  });

  return response.items ?? [];
}
