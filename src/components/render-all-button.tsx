'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * Phase 8 — batch pipeline button. Queues every clip of an episode in one
 * async render-service job (source downloaded once, all clips cut from it),
 * then polls the render-status endpoint until the job completes.
 */
export function RenderAllButton({
  videoId,
  total,
  alreadyDone,
}: {
  videoId: string;
  total: number;
  alreadyDone: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling(): void {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function poll(): Promise<void> {
    try {
      const response = await fetch(`/api/episodes/${videoId}/render-status`);
      const body = (await response.json().catch(() => null)) as {
        state?: string;
        rendered?: number;
        failed?: number;
        done?: number;
        total?: number;
      } | null;

      if (body?.state === 'done') {
        stopPolling();
        setBusy(false);
        setResult(`✅ ${body.rendered ?? 0} rendered, ${body.failed ?? 0} failed`);
        router.refresh();
      } else if (body?.state === 'error') {
        stopPolling();
        setBusy(false);
        setResult('⚠️ Render job failed');
        router.refresh();
      } else if (body?.state === 'idle') {
        stopPolling();
        setBusy(false);
        setResult(`✅ ${body.done ?? 0}/${body.total ?? 0} rendered`);
        router.refresh();
      } else {
        setResult('⏳ Rendering…');
      }
    } catch {
      // transient — keep polling
    }
  }

  async function run(): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(`/api/episodes/${videoId}/render-all`, { method: 'POST' });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        queued?: number;
        message?: string;
      } | null;
      if (!response.ok) {
        setResult(`⚠️ ${body?.error ?? `Failed with ${response.status}`}`);
        setBusy(false);
        return;
      }
      setResult(body?.message ?? `Queued ${body?.queued ?? 0} clip(s)`);
      pollRef.current = setInterval(() => void poll(), 5000);
    } catch (e) {
      setResult(`⚠️ ${e instanceof Error ? e.message : 'Render failed'}`);
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {result ? <span className="text-[11px] text-slate-400">{result}</span> : null}
      <button
        type="button"
        disabled={busy || total === 0 || alreadyDone === total}
        onClick={() => void run()}
        className={cn(
          'rounded-md px-3 py-1.5 text-[11px] font-medium ring-1 ring-inset transition-colors',
          'bg-indigo-500/15 text-indigo-200 ring-indigo-500/30 hover:bg-indigo-500/25',
          'disabled:opacity-50',
        )}
      >
        {busy
          ? '⏳ Rendering…'
          : alreadyDone === total
            ? '✓ All rendered'
            : `▶ Render all (${total - alreadyDone})`}
      </button>
    </div>
  );
}
