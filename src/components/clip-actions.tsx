'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ClipStatus } from '@/lib/db/repositories/clips';
import { cn } from '@/lib/utils/cn';

/**
 * Editor verdict controls.
 *
 * Each action writes both a workflow status and a feedback row. The feedback is
 * the point: it accumulates the labelled dataset that lets a future re-ranker
 * learn this creator's audience instead of relying on a general model's taste.
 */

const ACTIONS: {
  status: ClipStatus;
  verdict: 'agree' | 'rejected' | 'published';
  label: string;
  activeClass: string;
}[] = [
  {
    status: 'approved',
    verdict: 'agree',
    label: 'Approve',
    activeClass: 'bg-sky-500/20 text-sky-200 ring-sky-500/40',
  },
  {
    status: 'published',
    verdict: 'published',
    label: 'Published',
    activeClass: 'bg-emerald-500/20 text-emerald-200 ring-emerald-500/40',
  },
  {
    status: 'rejected',
    verdict: 'rejected',
    label: 'Reject',
    activeClass: 'bg-rose-500/20 text-rose-200 ring-rose-500/40',
  },
];

export function ClipActions({
  clipId,
  status,
}: {
  clipId: number;
  status: ClipStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState<ClipStatus>(status);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: (typeof ACTIONS)[number]): Promise<void> {
    setError(null);

    // Clicking the active state clears it back to "new".
    const target: ClipStatus = current === next.status ? 'new' : next.status;
    const previous = current;
    setCurrent(target);

    try {
      const response = await fetch(`/api/clips/${clipId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          target === 'new'
            ? { status: 'new' }
            : { status: target, feedback: { verdict: next.verdict } },
        ),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed with ${response.status}`);
      }

      startTransition(() => router.refresh());
    } catch (caught) {
      setCurrent(previous);
      setError(caught instanceof Error ? caught.message : 'Update failed');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ACTIONS.map((action) => (
        <button
          key={action.status}
          type="button"
          disabled={pending}
          onClick={() => void apply(action)}
          aria-pressed={current === action.status}
          className={cn(
            'rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors disabled:opacity-50',
            current === action.status
              ? action.activeClass
              : 'bg-slate-500/5 text-slate-400 ring-slate-500/20 hover:bg-slate-500/15 hover:text-slate-200',
          )}
        >
          {action.label}
        </button>
      ))}
      {error ? <span className="text-[11px] text-rose-400">{error}</span> : null}
    </div>
  );
}
