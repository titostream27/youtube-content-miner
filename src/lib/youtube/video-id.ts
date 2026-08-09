/**
 * Demo video identifiers.
 *
 * The fixture catalogue uses synthetic ids like `demo-ep-ai-judgment`, which are
 * deliberately not real YouTube ids. Anything that builds an outbound YouTube URL
 * has to check this first: a link to `watch?v=demo-ep-ai-judgment` renders as
 * "Video unavailable", which looks like a broken application rather than what it
 * actually is - a reminder that no API key is configured.
 *
 * Checked per row rather than from `config.youtube.demoMode`, because a database
 * seeded in demo mode keeps those rows after a key is added. The global flag
 * would then claim the links are live while half of them are not.
 */
export const DEMO_VIDEO_ID_PREFIX = 'demo-';

export function isDemoVideoId(videoId: string): boolean {
  return videoId.startsWith(DEMO_VIDEO_ID_PREFIX);
}
