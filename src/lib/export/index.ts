import type { ClipRecord } from '@/lib/db/repositories/clips';
import { CLIP_DIMENSION_LABELS } from '@/lib/scoring/weights';
import { CLIP_DIMENSION_KEYS } from '@/lib/domain/types';
import { tierLabel } from '@/lib/domain/thresholds';
import { formatTimecode, youtubeTimestampUrl } from '@/lib/youtube/duration';

/**
 * PRD "Export" - CSV and TXT for the MVP.
 *
 * The product does not edit video, so export is the handoff. Both formats are
 * built for a human editor opening them next to their NLE: absolute timecodes,
 * a clickable deep link to the exact second, and the reasoning behind each
 * pick.
 *
 * EDL / FCPXML / Premiere and DaVinci marker formats are the next milestone.
 * `formatSmpteTimecode` in `youtube/duration.ts` already produces the
 * frame-accurate timecodes those formats need.
 */

export type ExportFormat = 'csv' | 'txt';

export interface ExportDescriptor {
  format: ExportFormat;
  label: string;
  contentType: string;
  extension: string;
  description: string;
}

export const EXPORT_FORMATS: readonly ExportDescriptor[] = [
  {
    format: 'csv',
    label: 'CSV',
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
    description: 'Full metadata, one row per clip. Opens in Sheets or Excel.',
  },
  {
    format: 'txt',
    label: 'TXT',
    contentType: 'text/plain; charset=utf-8',
    extension: 'txt',
    description: 'Readable shot list grouped by episode, for pasting into a brief.',
  },
];

/** RFC 4180 escaping. */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

const CSV_COLUMNS = [
  'Title',
  'Score',
  'Confidence %',
  'Priority',
  'Category',
  'Licence',
  'Start',
  'End',
  'Duration (s)',
  'Episode',
  'Channel',
  'YouTube Link',
  'Why This Works',
  'Suggested Hook',
  'Suggested Caption',
  'Editing Notes',
  ...CLIP_DIMENSION_KEYS.map((key) => CLIP_DIMENSION_LABELS[key]),
  'Engine',
  'Status',
  'Transcript',
] as const;

export function clipsToCsv(clips: readonly ClipRecord[]): string {
  const rows: string[] = [CSV_COLUMNS.map(csvCell).join(',')];

  for (const clip of clips) {
    rows.push(
      [
        clip.title,
        clip.finalScore,
        clip.confidence,
        tierLabel(clip.tier),
        clip.category,
        clip.license ?? 'unknown',
        formatTimecode(clip.startSec),
        formatTimecode(clip.endSec),
        Math.round(clip.durationSec),
        clip.episodeTitle,
        clip.channelTitle,
        youtubeTimestampUrl(clip.videoId, clip.startSec),
        clip.whyThisWorks.join('; '),
        clip.suggestedHook,
        clip.suggestedCaption,
        clip.editingNotes,
        ...CLIP_DIMENSION_KEYS.map((key) => clip.dimensions[key]),
        clip.engine,
        clip.status,
        clip.transcript,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  // Excel needs a BOM to read UTF-8 correctly.
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export function clipsToTxt(clips: readonly ClipRecord[]): string {
  const lines: string[] = [];

  lines.push('AI PODCAST PRODUCER ASSISTANT - CLIP SHOT LIST');
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push(`${clips.length} clip${clips.length === 1 ? '' : 's'}`);
  lines.push('');

  // Group by episode so an editor works one source file at a time.
  const byEpisode = new Map<string, ClipRecord[]>();
  for (const clip of clips) {
    const bucket = byEpisode.get(clip.videoId) ?? [];
    bucket.push(clip);
    byEpisode.set(clip.videoId, bucket);
  }

  for (const [videoId, episodeClips] of byEpisode) {
    const first = episodeClips[0]!;
    lines.push('='.repeat(78));
    lines.push(first.episodeTitle);
    lines.push(`${first.channelTitle}  |  https://www.youtube.com/watch?v=${videoId}`);
    lines.push('='.repeat(78));
    lines.push('');

    const ordered = [...episodeClips].sort((a, b) => a.startSec - b.startSec);

    for (const clip of ordered) {
      lines.push(
        `[${formatTimecode(clip.startSec)} - ${formatTimecode(clip.endSec)}]  ` +
          `${Math.round(clip.durationSec)}s  ` +
          `SCORE ${clip.finalScore}  CONFIDENCE ${clip.confidence}%  ${tierLabel(clip.tier)}`,
      );
      lines.push(`  TITLE      ${clip.title}`);
      lines.push(`  CATEGORY   ${clip.category}`);
      lines.push(`  LICENCE    ${clip.license ?? 'unknown'}`);
      lines.push(`  LINK       ${youtubeTimestampUrl(clip.videoId, clip.startSec)}`);
      lines.push(`  WHY        ${clip.whyThisWorks.join(' / ')}`);
      if (clip.suggestedHook) lines.push(`  HOOK       ${clip.suggestedHook}`);
      if (clip.suggestedCaption) lines.push(`  CAPTION    ${clip.suggestedCaption}`);
      if (clip.editingNotes) lines.push(`  EDIT NOTES ${clip.editingNotes}`);
      lines.push('');
      lines.push(`  TRANSCRIPT`);
      for (const chunk of wrapText(clip.transcript, 72)) {
        lines.push(`    ${chunk}`);
      }
      lines.push('');
      lines.push('-'.repeat(78));
      lines.push('');
    }
  }

  return lines.join('\n');
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + word.length + 1 <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

export function renderExport(format: ExportFormat, clips: readonly ClipRecord[]): string {
  return format === 'csv' ? clipsToCsv(clips) : clipsToTxt(clips);
}

export function exportFilename(format: ExportFormat, scope: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const safeScope = scope.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const descriptor = EXPORT_FORMATS.find((entry) => entry.format === format)!;
  return `clips-${safeScope || 'all'}-${date}.${descriptor.extension}`;
}

export function exportDescriptor(format: ExportFormat): ExportDescriptor {
  const descriptor = EXPORT_FORMATS.find((entry) => entry.format === format);
  if (!descriptor) throw new Error(`Unsupported export format: ${format}`);
  return descriptor;
}
