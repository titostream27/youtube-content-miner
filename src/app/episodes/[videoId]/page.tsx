import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getEpisode } from '@/lib/db/repositories/episodes';
import { listClips } from '@/lib/db/repositories/clips';
import { getTranscript } from '@/lib/db/repositories/transcripts';
import { config } from '@/lib/config';
import { EPISODE_FACTOR_KEYS } from '@/lib/domain/types';
import { EPISODE_FACTOR_LABELS } from '@/lib/scoring/weights';
import { episodeFactorHelp } from '@/lib/scoring/episode-opportunity';
import { formatDurationLabel } from '@/lib/youtube/duration';
import { compactNumber, humanize, pluralize, shortDate } from '@/lib/utils/format';
import { Card, CardHeader, EmptyState, KeyValue, Meter, Pill } from '@/components/ui/primitives';
import { OpportunityScore } from '@/components/tier-badge';
import { ClipCard } from '@/components/clip-card';
import { ExportLinks } from '@/components/export-links';
import { AnalyzeButton } from '@/components/analyze-button';
import { RenderAllButton } from '@/components/render-all-button';
import { LicenseBadge } from '@/components/license-badge';
import { isDemoVideoId } from '@/lib/youtube/video-id';

export const dynamic = 'force-dynamic';

const TRANSCRIPT_SOURCE_LABEL: Record<string, string> = {
  youtube_manual: 'Human-authored captions',
  youtube_asr: 'Auto-generated captions',
  speech_to_text: 'Speech-to-text',
  fixture: 'Demo transcript',
};

/**
 * Episode detail: the full audit trail for one episode.
 *
 * Both scoring models are exposed side by side - the eight opportunity factors
 * that decided whether to analyse it, and every clip that came out. If the user
 * disagrees with either decision, the reasoning is right there and the analyse
 * button lets them override the gate.
 */
export default async function EpisodePage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  const episode = getEpisode(videoId);

  if (!episode) notFound();

  const clips = listClips({ videoId, sort: 'score', limit: 200 });
  const transcript = getTranscript(videoId);

  const publishable = clips.filter(
    (clip) => clip.finalScore >= config.pipeline.clipScoreThreshold,
  );
  const archived = clips.filter((clip) => clip.finalScore < config.pipeline.clipScoreThreshold);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/episodes" className="text-xs text-slate-500 hover:text-slate-300">
          &larr; Episode ranking
        </Link>
        <h1 className="mt-2 text-xl font-semibold leading-snug tracking-tight text-slate-100">
          {episode.title}
        </h1>
        <p className="numeric mt-1.5 text-sm text-slate-400">
          {episode.channelTitle} · {formatDurationLabel(episode.durationSeconds)} ·{' '}
          {compactNumber(episode.viewCount)} views · {shortDate(episode.publishedAt)}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <LicenseBadge license={episode.license} />
          <span className="text-slate-700">·</span>
          {isDemoVideoId(episode.videoId) ? (
            <span
              className="text-xs text-slate-600"
              title="Synthetic demo episode - there is no real video behind it. Set YOUTUBE_API_KEY to mine real podcasts."
            >
              Demo episode · no video
            </span>
          ) : (
            <a
              href={`https://www.youtube.com/watch?v=${episode.videoId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-sky-400 hover:underline"
            >
              Watch on YouTube
            </a>
          )}
          <span className="text-slate-700">·</span>
          <ExportLinks query={{ videoId: episode.videoId }} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {episode.analysisStatus !== 'analysed' ? (
            <Card>
              <CardHeader
                title={`Not analysed · ${humanize(episode.analysisStatus)}`}
                description={
                  episode.skipReason ??
                  'This episode has not been through transcript extraction and scoring.'
                }
                action={<AnalyzeButton videoId={episode.videoId} />}
              />
              <p className="px-5 py-4 text-xs leading-relaxed text-slate-500">
                The opportunity gate exists to avoid spending money on episodes unlikely to yield
                publishable moments. Analysing anyway is a deliberate override - useful when you
                know a show better than the heuristic does.
              </p>
            </Card>
          ) : null}

          {publishable.length > 0 ? (
            <section className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Publishable moments · {publishable.length}
                </h2>
                <div className="flex items-center gap-3">
                  {episode.analysisStatus === 'analysed' ? (
                    <AnalyzeButton videoId={episode.videoId} label="Re-analyse" />
                  ) : null}
                  <RenderAllButton
                    videoId={episode.videoId}
                    total={publishable.length}
                    alreadyDone={publishable.filter((c) => c.renderStatus === 'done').length}
                  />
                </div>
              </div>
              {publishable.map((clip) => (
                <ClipCard key={clip.id} clip={clip} showEpisode={false} />
              ))}
            </section>
          ) : episode.analysisStatus === 'analysed' ? (
            <EmptyState
              title="Analysed, but nothing cleared the threshold"
              description={
                <>
                  {pluralize(clips.length, 'moment')} were scored and none reached{' '}
                  {config.pipeline.clipScoreThreshold}. That is a valid result, not a failure - it
                  means this episode is not worth an editor&apos;s time, and the pipeline is saying
                  so instead of padding the list.
                </>
              }
              action={<AnalyzeButton videoId={episode.videoId} label="Re-analyse" />}
            />
          ) : null}

          {archived.length > 0 ? (
            <details className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)]">
              <summary className="cursor-pointer px-5 py-3 text-xs font-medium text-slate-400 hover:text-slate-200">
                Archive tier · {archived.length} scored below threshold
              </summary>
              <div className="space-y-3 border-t border-[var(--color-line)] px-5 py-4">
                <p className="text-[11px] leading-relaxed text-slate-500">
                  Kept for model training and future re-ranking. These never reach the editor.
                </p>
                <ul className="divide-y divide-[var(--color-line)]">
                  {archived.map((clip) => (
                    <li key={clip.id} className="flex items-start gap-3 py-2 text-xs">
                      <span className="numeric w-8 shrink-0 text-right font-semibold text-slate-500">
                        {clip.finalScore}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-slate-400">{clip.title}</span>
                        <span className="block truncate text-[11px] text-slate-600">
                          {clip.whyThisWorks.join(' / ')}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ) : null}
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader
              title="Episode Opportunity Score"
              description="Computed from metadata only, before any transcript was fetched"
              action={
                <OpportunityScore
                  score={episode.opportunityScore}
                  threshold={config.pipeline.episodeScoreThreshold}
                />
              }
            />
            <div className="space-y-2.5 px-5 py-4">
              {episode.opportunityFactors ? (
                EPISODE_FACTOR_KEYS.map((key) => (
                  <Meter
                    key={key}
                    label={EPISODE_FACTOR_LABELS[key]}
                    value={episode.opportunityFactors![key]}
                    hint={episodeFactorHelp[key]}
                  />
                ))
              ) : (
                <p className="text-xs text-slate-500">No factor breakdown stored.</p>
              )}
            </div>
            {episode.opportunityReasons.length > 0 ? (
              <div className="border-t border-[var(--color-line)] px-5 py-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                  Biggest drivers
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {episode.opportunityReasons.map((reason) => (
                    <li key={reason} className="numeric text-[11px] text-slate-400">
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Pipeline state" />
            <dl className="px-5 py-3">
              <KeyValue
                label="Status"
                value={<Pill>{humanize(episode.analysisStatus)}</Pill>}
              />
              <KeyValue label="Moments detected" value={episode.segmentCount || '-'} />
              <KeyValue label="Clips in library" value={episode.clipCount} />
              <KeyValue
                label="Transcript"
                value={
                  transcript
                    ? (TRANSCRIPT_SOURCE_LABEL[transcript.source] ?? transcript.source)
                    : 'Not fetched'
                }
              />
              {transcript ? (
                <>
                  <KeyValue label="Transcript words" value={compactNumber(transcript.wordCount)} />
                  <KeyValue label="Caption cues" value={compactNumber(transcript.cues.length)} />
                </>
              ) : null}
              <KeyValue
                label="Captions reported"
                value={
                  episode.hasCaptions === null
                    ? 'Unknown'
                    : episode.hasCaptions
                      ? 'Yes'
                      : 'No'
                }
              />
              <KeyValue label="Analysed" value={shortDate(episode.analysedAt)} />
            </dl>
          </Card>

          {episode.tags.length > 0 ? (
            <Card>
              <CardHeader title="Tags" />
              <div className="flex flex-wrap gap-1.5 px-5 py-4">
                {episode.tags.slice(0, 20).map((tag) => (
                  <Pill key={tag}>{tag}</Pill>
                ))}
              </div>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
