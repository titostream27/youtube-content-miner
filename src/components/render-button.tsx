'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { RenderStatus } from '@/lib/db/repositories/clips';
import { cn } from '@/lib/utils/cn';

/**
 * Render integration control.
 *
 * POSTs the clip to the render endpoint, which forwards [start, end] to the
 * external shorts render service (yt-dlp download + ffmpeg vertical crop).
 * The button reflects the persisted render state and links to the rendered
 * short when one exists.
 */
export function RenderButton({
  clipId,
  renderStatus,
  renderPath: _renderPath,
  renderError,
}: {
  clipId: number;
  renderStatus: RenderStatus;
  renderPath: string | null;
  renderError: string | null;
}) {
  const router = useRouter();
  const [_pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<RenderStatus>(renderStatus);
  const [error, setError] = useState<string | null>(renderError);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

  async function render(): Promise<void> {
    setBusy(true);
    setError(null);
    setPublicUrl(null);
    try {
      const response = await fetch(`/api/clips/${clipId}/render`, { method: 'POST' });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Render failed with ${response.status}`);
      }

      const result = (await response.json()) as {
        clip: { renderStatus: RenderStatus; renderPath: string | null; renderError: string | null };
        publicUrl: string | null;
      };

      setStatus(result.clip.renderStatus);
      setError(result.clip.renderError);
      setPublicUrl(result.publicUrl);
      startTransition(() => router.refresh());
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : 'Render failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy || status === 'rendering'}
        onClick={() => void render()}
        className={cn(
          'rounded-md px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors disabled:opacity-60',
          status === 'done'
            ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30 hover:bg-emerald-500/25'
            : 'bg-slate-500/5 text-slate-300 ring-slate-500/20 hover:bg-slate-500/15 hover:text-slate-100',
        )}
      >
        {busy || status === 'rendering'
          ? '⏳ Rendering…'
          : status === 'done'
            ? '↻ Re-render'
            : '▶ Render short'}
      </button>

      {status === 'done' ? (
        <a
          href={publicUrl ?? `/api/clips/${clipId}/render`}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-md bg-sky-500/15 px-2.5 py-1 text-[11px] font-medium text-sky-200 ring-1 ring-inset ring-sky-500/30 hover:bg-sky-500/25"
        >
          ▶ Watch mp4
        </a>
      ) : null}

      {error ? <span className="max-w-[260px] truncate text-[11px] text-rose-400" title={error}>{error}</span> : null}
    </div>
  );
}
