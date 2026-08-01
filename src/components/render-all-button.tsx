'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * Phase 8 — batch pipeline button. Renders every clip of an episode in one
 * render-service call (source downloaded once, all clips cut from it).
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

  async function run(): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(`/api/episodes/${videoId}/render-all`, { method: 'POST' });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        total?: number;
        rendered?: number;
        failed?: number;
        skipped?: number;
      } | null;
      if (!response.ok) {
        setResult(`⚠️ ${body?.error ?? `Failed with ${response.status}`}`);
        return;
      }
      setResult(
        `✅ ${body?.rendered ?? 0} rendered, ${body?.failed ?? 0} failed, ${body?.skipped ?? 0} skipped`,
      );
      router.refresh();
    } catch (e) {
      setResult(`⚠️ ${e instanceof Error ? e.message : 'Render failed'}`);
    } finally {
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
        {busy ? '⏳ Rendering all…' : alreadyDone === total ? '✓ All rendered' : `▶ Render all (${total - alreadyDone})`}
      </button>
    </div>
  );
}
