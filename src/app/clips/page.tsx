import Link from 'next/link';
import { Suspense } from 'react';
import { clipCategoryBreakdown, countClips, listClips } from '@/lib/db/repositories/clips';
import { LIBRARY_MIN_SCORE } from '@/lib/domain/thresholds';
import { clipQuerySchema } from '@/lib/api/schemas';
import { toClipFilters } from '@/lib/api/filters';
import { pluralize } from '@/lib/utils/format';
import { ClipFilters } from '@/components/clip-filters';
import { ClipTable } from '@/components/clip-table';
import { ExportLinks } from '@/components/export-links';
import { EmptyState, Pill, SectionTitle } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/**
 * The clip library.
 *
 * By default it shows only clips at or above the library threshold. Everything
 * below is still stored - it is the training dataset the PRD calls the long-term
 * moat - but it is not work, so it is not shown unless asked for.
 */
export default async function ClipsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = clipQuerySchema.safeParse(raw);
  const query = parsed.success ? parsed.data : {};

  const showingArchive = new Set((typeof query.tier === 'string' ? query.tier : '').split(','))
    .has('archive');

  const filters = {
    ...toClipFilters(query),
    // Hide archive-tier noise unless the user explicitly asks for it.
    minScore: query.minScore ?? (showingArchive ? undefined : LIBRARY_MIN_SCORE),
    limit: PAGE_SIZE,
    offset: query.offset ?? 0,
  };

  const clips = listClips(filters);
  const total = countClips({ ...filters, limit: undefined, offset: undefined });
  const categories = clipCategoryBreakdown({ ...filters, limit: undefined, offset: undefined });

  const offset = filters.offset ?? 0;
  const exportQuery = Object.fromEntries(
    Object.entries(raw)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, value as string]),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">Clip library</h1>
          <p className="mt-1 text-sm text-slate-400">
            {total === 0
              ? 'No clips match these filters.'
              : `${pluralize(total, 'clip')} matching. Sorted by ${query.sort ?? 'score'}.`}
          </p>
        </div>
        <ExportLinks query={exportQuery} />
      </div>

      <Suspense fallback={<div className="h-40 rounded-xl bg-[var(--color-surface-raised)]" />}>
        <ClipFilters />
      </Suspense>

      {categories.length > 1 ? (
        <div>
          <SectionTitle>Category mix</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((entry) => (
              <Pill key={entry.category} title={`Average score ${entry.averageScore}`}>
                {entry.category}
                <span className="numeric ml-1 text-slate-500">{entry.count}</span>
              </Pill>
            ))}
          </div>
        </div>
      ) : null}

      {clips.length === 0 ? (
        <EmptyState
          title="Nothing to cut here"
          description={
            <>
              Either no run has produced clips at this quality yet, or the filters are too narrow.
              Thresholds are deliberate - a weak batch of episodes produces fewer clips rather than
              a padded list.{' '}
              <Link href="/discover" className="text-sky-400 hover:underline">
                Run discovery
              </Link>{' '}
              or{' '}
              <Link href="/clips?tier=archive" className="text-sky-400 hover:underline">
                inspect the archive tier
              </Link>
              .
            </>
          }
        />
      ) : (
        <ClipTable clips={clips} />
      )}

      {total > PAGE_SIZE ? (
        <Pagination total={total} offset={offset} raw={exportQuery} />
      ) : null}
    </div>
  );
}

function Pagination({
  total,
  offset,
  raw,
}: {
  total: number;
  offset: number;
  raw: Record<string, string>;
}) {
  const build = (nextOffset: number): string => {
    const params = new URLSearchParams(raw);
    if (nextOffset <= 0) params.delete('offset');
    else params.set('offset', String(nextOffset));
    const query = params.toString();
    return query.length > 0 ? `/clips?${query}` : '/clips';
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex items-center justify-between gap-4 border-t border-[var(--color-line)] pt-4">
      {offset > 0 ? (
        <Link
          href={build(offset - PAGE_SIZE)}
          className="rounded-md bg-slate-500/10 px-3 py-1.5 text-xs text-slate-300 ring-1 ring-inset ring-slate-500/25 hover:bg-slate-500/20"
        >
          Previous
        </Link>
      ) : (
        <span />
      )}

      <span className="numeric text-[11px] text-slate-500">
        Page {page} of {pages}
      </span>

      {offset + PAGE_SIZE < total ? (
        <Link
          href={build(offset + PAGE_SIZE)}
          className="rounded-md bg-slate-500/10 px-3 py-1.5 text-xs text-slate-300 ring-1 ring-inset ring-slate-500/25 hover:bg-slate-500/20"
        >
          Next
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}
