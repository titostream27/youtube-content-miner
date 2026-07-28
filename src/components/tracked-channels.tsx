'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TrackedChannel } from '@/lib/db/repositories/channels';
import { compactNumber, relativeTime } from '@/lib/utils/format';
import { Card, CardHeader } from '@/components/ui/primitives';

/**
 * PRD Mode B watch list.
 *
 * Accepts whatever the user pastes - channel ID, URL, @handle, or the show's
 * name - because requiring a UC-prefixed ID is a needless research task. The
 * server resolves it before storing.
 */
export function TrackedChannels({
  initial,
  demoMode,
}: {
  initial: TrackedChannel[];
  demoMode: boolean;
}) {
  const router = useRouter();
  const [tracked, setTracked] = useState(initial);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (query.trim().length < 2) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/channels/tracked', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });

      const body = (await response.json()) as
        | { tracked: TrackedChannel[] }
        | { error?: string };

      if (!response.ok) {
        throw new Error(('error' in body && body.error) || 'Could not add channel');
      }

      setTracked((body as { tracked: TrackedChannel[] }).tracked);
      setQuery('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add channel');
    } finally {
      setPending(false);
    }
  }

  async function remove(channelId: string): Promise<void> {
    setError(null);

    try {
      const response = await fetch(
        `/api/channels/tracked?channelId=${encodeURIComponent(channelId)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) throw new Error('Could not remove channel');

      const body = (await response.json()) as { tracked: TrackedChannel[] };
      setTracked(body.tracked);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not remove channel');
    }
  }

  return (
    <Card>
      <CardHeader
        title="Tracked channels"
        description="Mode B monitors these for new episodes."
      />

      <form onSubmit={add} className="flex gap-2 px-5 py-4">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={demoMode ? 'The Signal Room' : 'Channel URL, @handle, ID or show name'}
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-black/25 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-500/50 focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-lg bg-slate-500/15 px-3 py-2 text-xs font-medium text-slate-200 ring-1 ring-inset ring-slate-500/30 hover:bg-slate-500/25 disabled:opacity-50"
        >
          {pending ? 'Resolving...' : 'Track'}
        </button>
      </form>

      {error ? <p className="px-5 pb-3 text-[11px] text-rose-400">{error}</p> : null}

      {!demoMode ? (
        <p className="px-5 pb-3 text-[11px] leading-relaxed text-slate-500">
          Resolving a handle or a name costs 100 YouTube quota units, so the channel ID is stored
          once and reused on every later run.
        </p>
      ) : null}

      {tracked.length === 0 ? (
        <p className="border-t border-[var(--color-line)] px-5 py-4 text-xs text-slate-500">
          No channels tracked yet.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
          {tracked.map((entry) => (
            <li key={entry.channelId} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-300">
                  {entry.channel?.title ?? entry.label ?? entry.channelId}
                </p>
                <p className="numeric mt-0.5 text-[11px] text-slate-500">
                  {entry.channel?.subscriberCount
                    ? `${compactNumber(entry.channel.subscriberCount)} subscribers · `
                    : ''}
                  {entry.episodeCount} episodes · {entry.clipCount} clips
                  {entry.lastCheckedAt ? ` · checked ${relativeTime(entry.lastCheckedAt)}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void remove(entry.channelId)}
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
