/** Presentation-only formatting helpers. */

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat('en-US');

/** `1234567` -> `1.2M`. Used wherever a number sits inside a dense table. */
export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return COMPACT.format(value);
}

export function fullNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return FULL.format(value);
}

/** `2026-07-20T...` -> `8 days ago`. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '-';

  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return '-';

  const diffMs = Date.now() - timestamp;
  const seconds = Math.round(diffMs / 1000);

  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.round(months / 12)}y ago`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** Turn `publish_immediately` into `Publish immediately` for generic labels. */
export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
