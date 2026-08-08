import Link from 'next/link';
import type { ClipRecord } from '@/lib/db/repositories/clips';
import { CLIP_DIMENSION_KEYS } from '@/lib/domain/types';
import { CLIP_DIMENSION_HELP, CLIP_DIMENSION_LABELS } from '@/lib/scoring/weights';
import { formatTimecode, youtubeTimestampUrl } from '@/lib/youtube/duration';
import { isDemoVideoId } from '@/lib/youtube/video-id';
import { Card, Meter, Pill } from '@/components/ui/primitives';
import { ScoreBadge, TierBadge } from '@/components/tier-badge';
import { ClipActions } from '@/components/clip-actions';
import { RenderButton } from '@/components/render-button';
import { SeoButton } from '@/components/seo-button';
import { PublishButton } from '@/components/publish-button';
import { LicenseBadge } from '@/components/license-badge';

/**
 * PRD Step 8 and Step 10 in one component.
 *
 * The layout is ordered by what an editor needs, in the order they need it:
 * the verdict (tier + score), then the timecode they will scrub to, then WHY the
 * clip was chosen, then the copy they can paste, and only then the raw
 * transcript and the dimension breakdown for anyone who wants to audit the
 * score.
 */
export function ClipCard({
  clip,
  showEpisode = true,
}: {
  clip: ClipRecord;
  showEpisode?: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-4 px-5 pt-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <TierBadge tier={clip.tier} />
            <Pill title="Primary content category">{clip.category}</Pill>
            <LicenseBadge license={clip.license} />
            <Pill
              title={
                clip.engine === 'llm'
                  ? 'Scored by an AI scoring agent'
                  : 'Scored by the deterministic heuristic engine (confidence capped)'
              }
              className={
                clip.engine === 'llm'
                  ? 'bg-sky-500/10 text-sky-300 ring-sky-500/20'
                  : 'bg-slate-500/10 text-slate-400 ring-slate-500/20'
              }
            >
              {clip.engine === 'llm' ? 'AI scored' : 'Heuristic'}
            </Pill>
            {clip.status !== 'new' ? (
              <Pill className="bg-violet-500/10 text-violet-300 ring-violet-500/20">
                {clip.status}
              </Pill>
            ) : null}
          </div>

          <h3 className="mt-2 text-[15px] font-semibold leading-snug text-slate-100">
            {clip.title}
          </h3>

          {showEpisode ? (
            <p className="mt-1 truncate text-xs text-slate-500">
              <Link
                href={`/episodes/${clip.videoId}`}
                className="hover:text-slate-300 hover:underline"
              >
                {clip.episodeTitle}
              </Link>
              <span className="mx-1.5">·</span>
              {clip.channelTitle}
            </p>
          ) : null}
        </div>

        <div className="text-right">
          <ScoreBadge score={clip.finalScore} confidence={clip.confidence} />
          <p className="mt-0.5 text-[11px] text-slate-500">score / confidence</p>
        </div>
      </div>

      {/* Timecodes: the thing the editor actually acts on. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-5 text-xs">
        <span className="numeric font-medium text-slate-300">
          {formatTimecode(clip.startSec)} - {formatTimecode(clip.endSec)}
        </span>
        <span className="numeric text-slate-500">{Math.round(clip.durationSec)}s</span>
        {isDemoVideoId(clip.videoId) ? (
          <span
            className="text-slate-600"
            title="Synthetic demo clip - there is no real video behind it. Set YOUTUBE_API_KEY to mine real podcasts."
          >
            Demo clip · no video
          </span>
        ) : (
          <a
            href={youtubeTimestampUrl(clip.videoId, clip.startSec)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sky-400 hover:text-sky-300 hover:underline"
          >
            Open at timecode
          </a>
        )}
      </div>

      {/* PRD Step 10 - why this clip was chosen. */}
      {clip.whyThisWorks.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5 px-5">
          {clip.whyThisWorks.map((reason) => {
            const negative = /needs context|weak|rambling|cannot|no hook|sponsor|unclear/i.test(
              reason,
            );
            return (
              <Pill
                key={reason}
                className={
                  negative
                    ? 'bg-amber-500/10 text-amber-300/90 ring-amber-500/20'
                    : 'bg-emerald-500/10 text-emerald-300/90 ring-emerald-500/20'
                }
              >
                {reason}
              </Pill>
            );
          })}
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 px-5 pb-4 lg:grid-cols-[1fr_240px]">
        <div className="space-y-3">
          {clip.suggestedHook ? (
            <Field label="Suggested hook">
              <span className="text-slate-300">&ldquo;{clip.suggestedHook}&rdquo;</span>
            </Field>
          ) : null}

          {clip.suggestedCaption ? (
            <Field label="Suggested caption">{clip.suggestedCaption}</Field>
          ) : null}

          {clip.editingNotes ? <Field label="Editing notes">{clip.editingNotes}</Field> : null}

          {clip.transcript ? (
            <details className="group">
              <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wider text-slate-500 hover:text-slate-300">
                Transcript
              </summary>
              <p className="mt-2 max-h-56 overflow-y-auto rounded-lg bg-black/20 p-3 text-xs leading-relaxed text-slate-400">
                {clip.transcript}
              </p>
            </details>
          ) : null}
        </div>

        {/* The audit trail: all ten dimensions behind the score. */}
        <div className="space-y-1.5 rounded-lg bg-black/15 p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Scoring breakdown
          </p>
          {CLIP_DIMENSION_KEYS.map((key) => (
            <Meter
              key={key}
              label={CLIP_DIMENSION_LABELS[key]}
              value={clip.dimensions[key]}
              hint={CLIP_DIMENSION_HELP[key]}
              emphasis={key === 'hook' || key === 'standalone' || key === 'clarity'}
            />
          ))}
          <p className="pt-1 text-[10px] leading-relaxed text-slate-600">
            Bold dimensions are prerequisites. A clip cannot reach the top tier while any of them
            fails.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] bg-black/10 px-5 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <ClipActions clipId={clip.id} status={clip.status} />
          <RenderButton
            clipId={clip.id}
            renderStatus={clip.renderStatus}
            renderPath={clip.renderPath}
            renderError={clip.renderError}
          />
          <SeoButton
            clipId={clip.id}
            existing={{
              title: clip.seoTitle,
              description: clip.seoDescription,
              tags: clip.seoTags,
            }}
          />
          <PublishButton
            clipId={clip.id}
            publishStatus={clip.publishStatus}
            publishUrl={clip.publishUrl}
            publishError={clip.publishError}
            renderStatus={clip.renderStatus}
            hasSeo={Boolean(clip.seoTitle)}
          />
        </div>
        <span className="numeric text-[11px] text-slate-600">clip #{clip.id}</span>
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">{children}</p>
    </div>
  );
}
