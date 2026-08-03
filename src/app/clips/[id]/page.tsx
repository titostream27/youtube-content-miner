import { notFound } from 'next/navigation';
import { getClip } from '@/lib/db/repositories/clips';
import TimelineEditor from '@/components/timeline-editor';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * Clip detail page with the Transcript Timeline Editor (brief §22).
 */
export default async function ClipDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const clipId = Number.parseInt(id, 10);
  if (!Number.isFinite(clipId)) notFound();

  const clip = getClip(clipId);
  if (!clip) notFound();

  return (
    <div>
      <div className="mb-2 text-xs text-slate-500">
        <Link href="/clips" className="text-sky-400 hover:underline">
          ← Clip library
        </Link>
        {' '}/ Clip #{clipId}
      </div>
      <TimelineEditor clipId={clipId} />
    </div>
  );
}
