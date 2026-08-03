'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { PublishStatus } from '@/lib/db/repositories/clips';
import { cn } from '@/lib/utils/cn';

/**
 * Phase 3 — publish integration control.
 *
 * POSTs the clip to the publish endpoint, which forwards the rendered short
 * + SEO metadata to the poster service (YouTube upload, private by default).
 * The button reflects the persisted publish state and links to the published
 * video when one exists.
 */
export function PublishButton({
  clipId,
  publishStatus,
  publishUrl,
  publishError,
  renderStatus,
  hasSeo,
}: {
  clipId: number;
  publishStatus: PublishStatus;
  publishUrl: string | null;
  publishError: string | null;
  renderStatus: string;
  hasSeo: boolean;
}) {
  const router = useRouter();
  const [_pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PublishStatus>(publishStatus);
  const [url, setUrl] = useState<string | null>(publishUrl);
  const [error, setError] = useState<string | null>(publishError);

  const disabled = busy || status === 'publishing' || renderStatus !== 'done' || !hasSeo;

  async function publish(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/clips/${clipId}/publish`, { method: 'POST' });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Publish failed with ${response.status}`);
      }

      const result = (await response.json()) as {
        clip: { publishStatus: PublishStatus; publishUrl: string | null; publishError: string | null };
        url: string | null;
      };

      setStatus(result.clip.publishStatus);
      setUrl(result.clip.publishUrl ?? result.url);
      setError(result.clip.publishError);
      startTransition(() => router.refresh());
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : 'Publish failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => void publish()}
        title={
          renderStatus !== 'done'
            ? 'Render the short first'
            : !hasSeo
              ? 'Generate SEO metadata first'
              : undefined
        }
        className={cn(
          'rounded-md px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors disabled:opacity-50',
          status === 'published'
            ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30 hover:bg-emerald-500/25'
            : 'bg-amber-500/10 text-amber-200/90 ring-amber-500/25 hover:bg-amber-500/20 hover:text-amber-100',
        )}
      >
        {busy || status === 'publishing'
          ? '⏳ Publishing…'
          : status === 'published'
            ? '✓ Published'
            : '🚀 Publish'}
      </button>

      {status === 'published' && url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-md bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-200 ring-1 ring-inset ring-emerald-500/30 hover:bg-emerald-500/25"
        >
          ▶ Watch on YouTube
        </a>
      ) : null}

      {error ? <span className="max-w-[260px] truncate text-[11px] text-rose-400" title={error}>{error}</span> : null}
    </div>
  );
}
