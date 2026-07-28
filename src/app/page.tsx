import Link from 'next/link';
import { listClips } from '@/lib/db/repositories/clips';
import { listEpisodes } from '@/lib/db/repositories/episodes';
import { listRuns } from '@/lib/db/repositories/runs';
import {
  getDashboardStats,
  getLibraryTotals,
  getTierCounts,
  startOfToday,
} from '@/lib/db/repositories/stats';
import { TIER_DEFINITIONS } from '@/lib/domain/thresholds';
import { formatDurationLabel } from '@/lib/youtube/duration';
import { compactNumber, formatDurationMs, pluralize, relativeTime } from '@/lib/utils/format';
import { Card, CardHeader, EmptyState, KeyValue, Pill, SectionTitle, Stat } from '@/components/ui/primitives';
import { OpportunityScore, TierBadge } from '@/components/tier-badge';
import { ClipCard } from '@/components/clip-card';

export const dynamic = 'force-dynamic';

/**
 * PRD "AI Dashboard".
 *
 * The success metric in the PRD is not clip count - it is high-confidence clips
 * that actually get published. So the page is built around one question: what
 * can I send to the editor right now? "Publish Immediately" leads, the full
 * threshold breakdown sits beside it for context, and everything else is
 * supporting evidence.
 */
export default function DashboardPage() {
  const since = startOfToday();
  const today = getDashboardStats(since);
  const totals = getLibraryTotals();
  const tierCounts = getTierCounts();
  const runs = listRuns(6);

  const readyToSend = listClips({
    tiers: ['publish_immediately', 'high_priority'],
    statuses: ['new', 'approved'],
    sort: 'score',
    limit: 4,
  });

  const topEpisodes = listEpisodes({ status: ['analysed'], sort: 'clips', limit: 5 });
  const hasAnyData = totals.episodesDiscovered > 0;

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">
          Turn every podcast into weeks of short-form content
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          The editor no longer watches three hours looking for moments. Enter a topic, and the
          pipeline ranks episodes, extracts transcripts, scores every candidate moment and hands
          back only the ones worth cutting.
        </p>
      </div>

      {!hasAnyData ? (
        <EmptyState
          title="Nothing mined yet"
          description={
            <>
              Run a discovery pass to populate the dashboard. With no API keys configured the
              pipeline still runs end to end against a synthetic demo catalogue, so you can see
              every stage work before spending anything.
            </>
          }
          action={
            <Link
              href="/discover"
              className="rounded-lg bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-200 ring-1 ring-inset ring-sky-500/30 hover:bg-sky-500/25"
            >
              Start a discovery run
            </Link>
          }
        />
      ) : null}

      <section>
        <SectionTitle hint="since midnight local time">Today</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat
            label="Podcasts found"
            value={today.podcastsDiscovered}
            hint="Episodes surfaced by discovery"
          />
          <Stat
            label="Episodes analysed"
            value={today.episodesAnalysed}
            hint="Cleared the opportunity gate"
          />
          <Stat
            label="Potential clips"
            value={today.potentialClips}
            hint="Scored at or above threshold"
            href="/clips"
          />
          <Stat
            label="High priority"
            value={today.highPriority}
            hint="Score 90-94"
            accent="primary"
            href="/clips?tier=high_priority"
          />
          <Stat
            label="Publish immediately"
            value={today.publishImmediately}
            hint="Score 95+, send straight to the editor"
            accent="success"
            href="/clips?tier=publish_immediately"
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section>
          <SectionTitle hint={<Link href="/clips" className="hover:text-slate-300">View all clips</Link>}>
            Ready for the editor
          </SectionTitle>

          {readyToSend.length === 0 ? (
            <EmptyState
              title="No high-priority clips yet"
              description={
                <>
                  Nothing has scored 90 or above. That is a normal outcome - the pipeline uses
                  thresholds rather than a fixed clip count, so a weak batch of episodes correctly
                  produces fewer clips instead of padding the list.{' '}
                  <Link href="/clips?tier=good_candidate,optional" className="text-sky-400 hover:underline">
                    Browse lower tiers
                  </Link>
                  .
                </>
              }
            />
          ) : (
            <div className="space-y-4">
              {readyToSend.map((clip) => (
                <ClipCard key={clip.id} clip={clip} />
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <Card>
            <CardHeader
              title="Threshold breakdown"
              description="All clips ever scored, by priority tier"
            />
            <div className="divide-y divide-[var(--color-line)]">
              {TIER_DEFINITIONS.map((definition) => (
                <Link
                  key={definition.tier}
                  href={`/clips?tier=${definition.tier}`}
                  className="flex items-center justify-between gap-3 px-5 py-2.5 transition-colors hover:bg-[var(--color-surface-hover)]"
                >
                  <TierBadge tier={definition.tier} />
                  <span className="numeric text-sm font-medium tabular-nums text-slate-300">
                    {tierCounts[definition.tier]}
                  </span>
                </Link>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Library" description="Everything mined so far" />
            <dl className="px-5 py-3">
              <KeyValue label="Episodes discovered" value={totals.episodesDiscovered} />
              <KeyValue label="Episodes analysed" value={totals.episodesAnalysed} />
              <KeyValue
                label="Episodes skipped"
                value={
                  <span title="Skipped before transcription by the Episode Opportunity Score - this is the pipeline saving money">
                    {totals.episodesSkipped}
                  </span>
                }
              />
              <KeyValue label="Moments scored" value={totals.clipsTotal} />
              <KeyValue label="Clips in library" value={totals.clipsInLibrary} />
              <KeyValue label="Average score" value={totals.averageScore || '-'} />
              <KeyValue
                label="Average confidence"
                value={totals.averageConfidence ? `${totals.averageConfidence}%` : '-'}
              />
              <KeyValue
                label="Audio mined"
                value={
                  <span title="Total runtime of analysed episodes - the time an editor would otherwise have spent scrubbing">
                    {totals.hoursMined}h
                  </span>
                }
              />
            </dl>
          </Card>

          <Card>
            <CardHeader
              title="Recent runs"
              description="Pipeline executions, newest first"
            />
            {runs.length === 0 ? (
              <p className="px-5 py-4 text-xs text-slate-500">No runs yet.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-line)]">
                {runs.map((run) => (
                  <li key={run.id} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-slate-300">
                        {run.topic ?? run.mode.replace(/_/g, ' ')}
                      </span>
                      <Pill
                        className={
                          run.status === 'completed'
                            ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                            : run.status === 'failed'
                              ? 'bg-rose-500/10 text-rose-300 ring-rose-500/20'
                              : 'bg-amber-500/10 text-amber-300 ring-amber-500/20'
                        }
                      >
                        {run.status}
                      </Pill>
                    </div>
                    <p className="numeric mt-1 text-[11px] text-slate-500">
                      {run.episodesDiscovered} found · {run.episodesAnalysed} analysed ·{' '}
                      {pluralize(run.clipsFound, 'clip')}
                      {run.durationMs !== null ? ` · ${formatDurationMs(run.durationMs)}` : ''}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-600">
                      {relativeTime(run.startedAt)} · {run.engine === 'llm' ? 'AI scored' : 'heuristic'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>

      {topEpisodes.length > 0 ? (
        <section>
          <SectionTitle
            hint={<Link href="/episodes" className="hover:text-slate-300">View episode ranking</Link>}
          >
            Most productive episodes
          </SectionTitle>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-[var(--color-line)]">
              {topEpisodes.map((episode) => (
                <li key={episode.videoId}>
                  <Link
                    href={`/episodes/${episode.videoId}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-[var(--color-surface-hover)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-slate-200">{episode.title}</p>
                      <p className="numeric mt-0.5 text-[11px] text-slate-500">
                        {episode.channelTitle} · {formatDurationLabel(episode.durationSeconds)} ·{' '}
                        {compactNumber(episode.viewCount)} views
                      </p>
                    </div>
                    <span className="numeric text-xs text-slate-400">
                      {pluralize(episode.clipCount, 'clip')}
                    </span>
                    <div className="w-12 text-right" title="Episode Opportunity Score">
                      <OpportunityScore score={episode.opportunityScore} size="sm" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
