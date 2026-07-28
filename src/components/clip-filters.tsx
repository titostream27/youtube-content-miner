'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { CLIP_CATEGORIES } from '@/lib/domain/categories';
import { TIER_DEFINITIONS } from '@/lib/domain/thresholds';
import { cn } from '@/lib/utils/cn';

/**
 * PRD Step 7 as a working control surface.
 *
 * Filter state lives in the URL rather than in component state, for two
 * reasons: the view is shareable with a teammate ("here are today's publish-now
 * clips"), and the export endpoint can be handed the exact same query string so
 * a download always matches what was on screen.
 */

const SORTS = [
  { value: 'score', label: 'Score' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'recent', label: 'Newest' },
  { value: 'duration', label: 'Shortest' },
] as const;

export function ClipFilters() {
  const router = useRouter();
  const params = useSearchParams();

  const activeTiers = new Set((params.get('tier') ?? '').split(',').filter(Boolean));
  const activeCategories = new Set((params.get('category') ?? '').split(',').filter(Boolean));
  const activeLicenses = new Set((params.get('license') ?? '').split(',').filter(Boolean));
  const sort = params.get('sort') ?? 'score';
  const [search, setSearch] = useState(params.get('search') ?? '');

  function commit(next: URLSearchParams): void {
    const query = next.toString();
    router.push(query.length > 0 ? `/clips?${query}` : '/clips');
  }

  function toggleMulti(key: 'tier' | 'category' | 'license', value: string): void {
    const next = new URLSearchParams(params.toString());
    const current = new Set((next.get(key) ?? '').split(',').filter(Boolean));

    if (current.has(value)) current.delete(value);
    else current.add(value);

    if (current.size === 0) next.delete(key);
    else next.set(key, Array.from(current).join(','));

    commit(next);
  }

  function setParam(key: string, value: string | null): void {
    const next = new URLSearchParams(params.toString());
    if (value === null || value.length === 0) next.delete(key);
    else next.set(key, value);
    commit(next);
  }

  const hasFilters = Array.from(params.keys()).length > 0;

  return (
    <div className="space-y-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-5 py-4">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Priority</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TIER_DEFINITIONS.map((definition) => (
            <button
              key={definition.tier}
              type="button"
              onClick={() => toggleMulti('tier', definition.tier)}
              title={definition.description}
              className={cn(
                'rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors',
                activeTiers.has(definition.tier)
                  ? definition.className
                  : 'bg-slate-500/5 text-slate-400 ring-slate-500/20 hover:bg-slate-500/15 hover:text-slate-200',
              )}
            >
              {definition.label}
              <span className="ml-1.5 font-normal opacity-70">
                {definition.minScore}
                {definition.maxScore < 100 ? `-${definition.maxScore}` : '+'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Category</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CLIP_CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => toggleMulti('category', category)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[11px] ring-1 ring-inset transition-colors',
                activeCategories.has(category)
                  ? 'bg-violet-500/15 text-violet-200 ring-violet-500/30'
                  : 'bg-slate-500/5 text-slate-400 ring-slate-500/20 hover:bg-slate-500/15 hover:text-slate-200',
              )}
            >
              {category}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
          Reuse rights
        </p>
        <p className="mt-1 text-[11px] leading-snug text-slate-600">
          CC BY videos are licensed for reuse with attribution. Standard licence needs the
          owner&apos;s permission before publishing.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[
            { value: 'creativeCommon', label: 'CC BY · reusable', active: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30' },
            { value: 'youtube', label: 'Standard licence', active: 'bg-amber-500/15 text-amber-200 ring-amber-500/30' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => toggleMulti('license', option.value)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[11px] ring-1 ring-inset transition-colors',
                activeLicenses.has(option.value)
                  ? option.active
                  : 'bg-slate-500/5 text-slate-400 ring-slate-500/20 hover:bg-slate-500/15 hover:text-slate-200',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setParam('search', search.trim());
          }}
        >
          <label
            htmlFor="clip-search"
            className="block text-[11px] font-medium uppercase tracking-wider text-slate-500"
          >
            Search
          </label>
          <input
            id="clip-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title, transcript or episode"
            className="mt-1.5 w-full rounded-lg border border-[var(--color-line)] bg-black/25 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-500/50 focus:outline-none"
          />
        </form>

        <div>
          <label
            htmlFor="min-confidence"
            className="block text-[11px] font-medium uppercase tracking-wider text-slate-500"
          >
            Min confidence
          </label>
          <select
            id="min-confidence"
            value={params.get('minConfidence') ?? ''}
            onChange={(event) => setParam('minConfidence', event.target.value)}
            className="mt-1.5 rounded-lg border border-[var(--color-line)] bg-black/25 px-2 py-1.5 text-xs text-slate-300 focus:border-sky-500/50 focus:outline-none"
          >
            <option value="">Any</option>
            <option value="70">70%+</option>
            <option value="80">80%+</option>
            <option value="90">90%+</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="clip-status"
            className="block text-[11px] font-medium uppercase tracking-wider text-slate-500"
          >
            Status
          </label>
          <select
            id="clip-status"
            value={params.get('status') ?? ''}
            onChange={(event) => setParam('status', event.target.value)}
            className="mt-1.5 rounded-lg border border-[var(--color-line)] bg-black/25 px-2 py-1.5 text-xs text-slate-300 focus:border-sky-500/50 focus:outline-none"
          >
            <option value="">All</option>
            <option value="new">Not reviewed</option>
            <option value="approved">Approved</option>
            <option value="published">Published</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="clip-sort"
            className="block text-[11px] font-medium uppercase tracking-wider text-slate-500"
          >
            Sort
          </label>
          <select
            id="clip-sort"
            value={sort}
            onChange={(event) => setParam('sort', event.target.value)}
            className="mt-1.5 rounded-lg border border-[var(--color-line)] bg-black/25 px-2 py-1.5 text-xs text-slate-300 focus:border-sky-500/50 focus:outline-none"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {hasFilters ? (
        <button
          type="button"
          onClick={() => router.push('/clips')}
          className="text-[11px] text-slate-500 underline hover:text-slate-300"
        >
          Clear all filters
        </button>
      ) : null}
    </div>
  );
}
