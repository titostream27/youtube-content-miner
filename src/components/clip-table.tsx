'use client';

import Link from 'next/link';
import type { ClipRecord } from '@/lib/db/repositories/clips';
import { formatTimecode } from '@/lib/youtube/duration';
import { RenderButton } from '@/components/render-button';
import { SeoButton } from '@/components/seo-button';
import { PublishButton } from '@/components/publish-button';

/**
 * Pipeline view (Option B), responsive.
 *
 * Desktop (md+): full table — one row per clip, columns = pipeline stages
 * (Render -> SEO -> Publish), so a glance tells you where each clip is stuck.
 *
 * Mobile (<md): the same data renders as stacked cards — title + timecode +
 * score, then the three stage buttons — because a 6-column table does not fit
 * a phone screen and hidden columns confuse users.
 */

function ClipIdentity({ clip }: { clip: ClipRecord }) {
  return (
    <div className="min-w-0">
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
        <span className="numeric">{formatTimecode(clip.startSec)}</span>
      </p>
    </div>
  );
}

function StageButtons({ clip }: { clip: ClipRecord }) {
  const seoDone = Boolean(clip.seoTitle);
  return (
    <div className="flex flex-wrap items-center gap-2">
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
        hasSeo={seoDone}
      />
    </div>
  );
}

export function ClipTable({ clips }: { clips: ClipRecord[] }) {
  return (
    <>
      {/* ── Mobile: stacked cards ─────────────────────────────────────── */}
      <div className="space-y-3 md:hidden">
        {clips.map((clip) => (
          <div
            key={clip.id}
            className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-3.5"
          >
            <div className="flex items-start justify-between gap-3">
              <ClipIdentity clip={clip} />
              <div className="shrink-0 text-right">
                <span className="numeric text-sm font-semibold text-slate-200">
                  {clip.finalScore}
                </span>
                <span className="numeric ml-0.5 text-[10px] text-slate-500">
                  /{clip.confidence}
                </span>
                <p className="text-[10px] text-slate-500">
                  {Math.round(clip.durationSec)}s
                </p>
              </div>
            </div>
            <div className="mt-3">
              <StageButtons clip={clip} />
            </div>
          </div>
        ))}
      </div>

      {/* ── Desktop: full pipeline table ─────────────────────────────── */}
      <div className="hidden overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)] md:block">
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
            {clips.map((clip) => (
              <tr
                key={clip.id}
                className="border-b border-[var(--color-line)]/60 last:border-0 hover:bg-white/[0.02]"
              >
                <td className="max-w-[340px] px-4 py-3">
                  <ClipIdentity clip={clip} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-slate-400">
                  {Math.round(clip.durationSec)}s
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <span className="numeric font-semibold text-slate-200">{clip.finalScore}</span>
                  <span className="numeric ml-1 text-[10px] text-slate-500">
                    /{clip.confidence}
                  </span>
                </td>
                <td className="px-3 py-3">
                  <StageButtons clip={clip} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
