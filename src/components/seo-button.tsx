'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';

export interface SeoData {
  titles: string[];
  description: string;
  tags: string[];
}

/**
 * Phase 2 — SEO metadata generation control.
 *
 * POSTs the clip to the SEO endpoint, which runs the LLM agent (DeepSeek by
 * default) over the clip transcript and persists titles/description/tags.
 * Results expand inline so the editor can copy them for the platform.
 */
export function SeoButton({
  clipId,
  existing,
  disabled,
}: {
  clipId: number;
  existing?: { title: string | null; description: string | null; tags: string[] } | null;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seo, setSeo] = useState<SeoData | null>(
    existing?.title
      ? {
          titles: [existing.title],
          description: existing.description ?? '',
          tags: existing.tags,
        }
      : null,
  );
  const [copied, setCopied] = useState(false);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch(`/api/clips/${clipId}/seo`, { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `SEO generation failed with ${response.status}`);
      }
      const result = (await response.json()) as { seo: SeoData };
      setSeo(result.seo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'SEO generation failed');
    } finally {
      setBusy(false);
    }
  }

  function copyAll(): void {
    if (!seo) return;
    const text = [
      ...seo.titles.map((t) => `TITLE: ${t}`),
      '',
      seo.description,
      '',
      seo.tags.map((t) => `#${t}`).join(' '),
    ].join('\n');
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => void generate()}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors disabled:opacity-60',
            seo
              ? 'bg-violet-500/15 text-violet-200 ring-violet-500/30 hover:bg-violet-500/25'
              : 'bg-slate-500/5 text-slate-300 ring-slate-500/20 hover:bg-slate-500/15 hover:text-slate-100',
          )}
        >
          {busy ? '⏳ Generating SEO…' : seo ? '↻ Regenerate SEO' : '✨ Generate SEO'}
        </button>

        {seo ? (
          <button
            type="button"
            onClick={copyAll}
            className="rounded-md bg-slate-500/10 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-inset ring-slate-500/20 hover:bg-slate-500/20"
          >
            {copied ? '✓ Copied' : '📋 Copy all'}
          </button>
        ) : null}

        {error ? <span className="max-w-[260px] truncate text-[11px] text-rose-400" title={error}>{error}</span> : null}
      </div>

      {seo ? (
        <div className="flex flex-col gap-1.5 rounded-md bg-slate-950/60 p-2.5 text-[11px] ring-1 ring-inset ring-slate-700/40">
          <div className="font-medium text-violet-300">SEO Titles</div>
          <ul className="list-inside list-disc space-y-0.5 text-slate-300">
            {seo.titles.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <div className="mt-1 font-medium text-violet-300">Description</div>
          <p className="whitespace-pre-wrap text-slate-300">{seo.description}</p>
          <div className="mt-1 font-medium text-violet-300">Hashtags</div>
          <p className="text-sky-300">{seo.tags.map((t) => `#${t}`).join(' ')}</p>
        </div>
      ) : null}
    </div>
  );
}
