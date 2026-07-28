'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Re-run Steps 3-8 for a single episode.
 *
 * Two real uses: the scoring model changed and this episode needs re-scoring, or
 * the opportunity gate skipped it and the user disagrees. The second case is why
 * this bypasses the gate entirely - the user overriding the cost heuristic is a
 * legitimate action, not an error.
 */
export function AnalyzeButton({
  videoId,
  label = 'Analyse now',
}: {
  videoId: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setPending(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/episodes/${encodeURIComponent(videoId)}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      const body = (await response.json()) as
        | { clips: unknown[]; segmentCount: number; engine: string; warnings: string[] }
        | { error?: string };

      if (!response.ok) {
        throw new Error(('error' in body && body.error) || `Failed with ${response.status}`);
      }

      const result = body as { clips: unknown[]; segmentCount: number; engine: string };
      setMessage(
        `${result.clips.length} clip${result.clips.length === 1 ? '' : 's'} from ${result.segmentCount} moments (${result.engine === 'llm' ? 'AI scored' : 'heuristic'})`,
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Analysis failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={pending}
        className="rounded-lg bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-200 ring-1 ring-inset ring-sky-500/30 transition-colors hover:bg-sky-500/25 disabled:opacity-50"
      >
        {pending ? 'Analysing...' : label}
      </button>
      {message ? <span className="text-[11px] text-emerald-300">{message}</span> : null}
      {error ? <span className="text-[11px] text-rose-400">{error}</span> : null}
    </div>
  );
}
