'use client';

import Link from 'next/link';
import type { ClipRecord } from '@/lib/db/repositories/clips';
import { formatTimecode } from '@/lib/youtube/duration';
import { cn } from '@/lib/utils/cn';
import { RenderButton } from '@/components/render-button';
import { SeoButton } from '@/components/seo-button';
import { PublishButton } from '@/components/publish-button';

/**
 * Pipeline table view (Option B).
 *
 * One row per clip; columns are the pipeline stages (render -> seo -> publish).
 * A glance at the row tells you exactly where each clip is stuck and the button
 * for the next step is right there. Technical detail (score dimensions,
 * transcript, editing notes) is intentionally NOT here — keep the row scannable.
 */

function StageBadge({
  label,
  tone,
}: {
  label: string;
  tone: 'done' | 'pending' | 'error' | 'busy';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset',
        tone === 'done' && 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25',
        tone === 'pending' && 'bg-slate-500/5 text-slate-400 ring-slate-500/15',
        tone === 'error' && 'bg-rose-500/10 text-rose-300 ring-rose-500/25',
        tone === 'busy' && 'bg-amber-500/10 text-amber-300 ring-amber-500/25',
      )}
    >
      {label}
    </span>
  );
}

export function ClipTable({ clips }: { clips: ClipRecord[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)]">
      <table className="w-full min-w-[860px] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-[var(--color-line)] text-[10px] uppercase tracking-wider text-slate-500">
            <th className="px-4 py-2.5 font-medium">Clip</th>
            <th className="px-3 py-2.5 font-medium">Durasi</th>
            <th className="px-3 py-2.5 font-medium">Score</th>
            <th className="px-3 py-2.5 font-medium">Render</th>
            <th className="px-3 py-2.5 font-medium">SEO</th>
            <th className="px-3 py-2.5 font-medium">Publish</th>
          </tr>
        </thead>
        <tbody>
          {clips.map((clip) => {
            const renderDone = clip.renderStatus === 'done';
            const seoDone = Boolean(clip.seoTitle);
            const published = clip.publishStatus === 'published';
            return (
              <tr
                key={clip.id}
                className="border-b border-[var(--color-line)]/60 last:border-0 hover:bg-white/[0.02]"
              >
                {/* Clip: title + episode link + timecode */}
                <td className="max-w-[340px] px-4 py-3">
                  <p className="truncate font-medium text-slate-200" title={clip.title}>
                    {clip.title}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-slate-500">
                    <Link
                      href={`/episodes/${clip.videoId}`}
                      className="hover:text-slate-300 hover:underline"
                    >
                      {clip.episodeTitle}
                    </Link>
                    <span className="mx-1 text-slate-600">·</span>
                    {formatTimecode(clip.startSec)}
                  </p>
                </td>

                {/* Durasi */}
                <td className="whitespace-nowrap px-3 py-3 text-slate-400">
                  {Math.round(clip.durationSec)}s
                </td>

                {/* Score */}
                <td className="whitespace-nowrap px-3 py-3">
                  <span className="numeric font-semibold text-slate-200">{clip.finalScore}</span>
                  <span className="numeric ml-1 text-[10px] text-slate-500">
                    /{clip.confidence}
                  </span>
                </td>

                {/* Render stage */}
                <td className="px-3 py-3">
                  <RenderButton
                    clipId={clip.id}
                    renderStatus={clip.renderStatus}
                    renderPath={clip.renderPath}
                    renderError={clip.renderError}
                  />
                </td>

                {/* SEO stage */}
                <td className="px-3 py-3">
                  <SeoButton
                    clipId={clip.id}
                    existing={{
                      title: clip.seoTitle,
                      description: clip.seoDescription,
                      tags: clip.seoTags,
                    }}
                  />
                </td>

                {/* Publish stage */}
                <td className="px-3 py-3">
                  <PublishButton
                    clipId={clip.id}
                    publishStatus={clip.publishStatus}
                    publishUrl={clip.publishUrl}
                    publishError={clip.publishError}
                    renderStatus={clip.renderStatus}
                    hasSeo={seoDone}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Compact stage summary used in the row header (optional, kept small). */
export function StageSummary({ clip }: { clip: ClipRecord }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StageBadge
        label={clip.renderStatus === 'done' ? 'Rendered' : clip.renderStatus === 'error' ? 'Render error' : 'Not rendered'}
        tone={clip.renderStatus === 'done' ? 'done' : clip.renderStatus === 'error' ? 'error' : 'pending'}
      />
      <StageBadge
        label={clip.seoTitle ? 'SEO ready' : 'No SEO'}
        tone={clip.seoTitle ? 'done' : 'pending'}
      />
      <StageBadge
        label={clip.publishStatus === 'published' ? 'Published' : clip.publishStatus === 'error' ? 'Publish error' : 'Draft'}
        tone={clip.publishStatus === 'published' ? 'done' : clip.publishStatus === 'error' ? 'error' : 'pending'}
      />
    </div>
  );
}
