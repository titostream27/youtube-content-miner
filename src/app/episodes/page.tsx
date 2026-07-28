import Link from 'next/link';
import { countEpisodes, listEpisodes } from '@/lib/db/repositories/episodes';
import { episodeQuerySchema } from '@/lib/api/schemas';
import { toEpisodeFilters } from '@/lib/api/filters';
import { config } from '@/lib/config';
import { formatDurationLabel } from '@/lib/youtube/duration';
import { compactNumber, pluralize, relativeTime } from '@/lib/utils/format';
import { Card, EmptyState, Pill } from '@/components/ui/primitives';
import { OpportunityScore } from '@/components/tier-badge';
import { cn } from '@/lib/utils/cn';

export const dynamic = 'force-dynamic';

const STATUS_STYLES: Record<string, string> = {
  analysed: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20',
  skipped: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
  discovered: 'bg-sky-500/10 text-sky-300 ring-sky-500/20',
  failed: 'bg-rose-500/10 text-rose-300 ring-rose-500/20',
};

const FILTERS = [
  { label: 'All', status: undefined },
  { label: 'Analysed', status: 'analysed' },
  { label: 'Skipped', status: 'skipped' },
  { label: 'Failed', status: 'failed' },
] as const;

/**
 * PRD Step 1 and Step 2 output: the episode ranking.
 *
 * Skipped episodes are shown alongside analysed ones on purpose. "Why did you
 * not analyse this one?" is a question the user will ask on day one, and the
 * answer - a score and a reason - is the clearest demonstration that the cost
 * gate is working rather than silently dropping things.
 */
export default async function EpisodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = episodeQuerySchema.safeParse(raw);
  const query = parsed.success ? parsed.data : {};

  const filters = { ...toEpisodeFilters(query), limit: 60 };
  const episodes = listEpisodes(filters);
  const total = countEpisodes({});
  const activeStatus = typeof raw.status === 'string' ? raw.status : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Episode ranking</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          Every episode discovery has surfaced, scored before transcription. Episodes below the{' '}
          <span className="numeric text-slate-300">{config.pipeline.episodeScoreThreshold}</span>{' '}
          threshold are never transcribed, which is where most of the cost saving comes from.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((filter) => {
          const isActive = activeStatus === filter.status;
          const href = filter.status ? `/episodes?status=${filter.status}` : '/episodes';
          return (
            <Link
              key={filter.label}
              href={href}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors',
                isActive
                  ? 'bg-sky-500/15 text-sky-200 ring-sky-500/30'
                  : 'bg-slate-500/5 text-slate-400 ring-slate-500/20 hover:bg-slate-500/15 hover:text-slate-200',
              )}
            >
              {filter.label}
            </Link>
          );
        })}
        <span className="ml-2 text-[11px] text-slate-500">{pluralize(total, 'episode')} total</span>
      </div>

      {episodes.length === 0 ? (
        <EmptyState
          title="No episodes yet"
          description={
            <>
              Discovery has not run.{' '}
              <Link href="/discover" className="text-sky-400 hover:underline">
                Start a run
              </Link>{' '}
              to populate the ranking.
            </>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[3rem_1fr_7rem_6rem_5rem_6rem] gap-4 border-b border-[var(--color-line)] px-5 py-2.5 text-[11px] font-medium uppercase tracking-wider text-slate-500 lg:grid">
            <span className="text-right">Score</span>
            <span>Episode</span>
            <span>Status</span>
            <span className="text-right">Clips</span>
            <span className="text-right">Length</span>
            <span className="text-right">Views</span>
          </div>

          <ul className="divide-y divide-[var(--color-line)]">
            {episodes.map((episode) => (
              <li key={episode.videoId}>
                <Link
                  href={`/episodes/${episode.videoId}`}
                  className="grid grid-cols-1 gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-[var(--color-surface-hover)] lg:grid-cols-[3rem_1fr_7rem_6rem_5rem_6rem] lg:items-center"
                >
                  <span className="text-right">
                    <OpportunityScore
                      score={episode.opportunityScore}
                      threshold={config.pipeline.episodeScoreThreshold}
                      size="sm"
                    />
                  </span>

                  <span className="min-w-0">
                    <span className="block truncate text-sm text-slate-200">{episode.title}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                      {episode.channelTitle}
                      {episode.topic ? ` · found via "${episode.topic}"` : ''} ·{' '}
                      {relativeTime(episode.publishedAt)}
                    </span>
                    {episode.skipReason ? (
                      <span className="mt-0.5 block truncate text-[11px] text-slate-600">
                        {episode.skipReason}
                      </span>
                    ) : null}
                  </span>

                  <span>
                    <Pill className={STATUS_STYLES[episode.analysisStatus]}>
                      {episode.analysisStatus}
                    </Pill>
                  </span>

                  <span className="numeric text-right text-xs text-slate-400">
                    {episode.analysisStatus === 'analysed' ? episode.clipCount : '-'}
                  </span>

                  <span className="numeric text-right text-xs text-slate-500">
                    {formatDurationLabel(episode.durationSeconds)}
                  </span>

                  <span className="numeric text-right text-xs text-slate-500">
                    {compactNumber(episode.viewCount)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
