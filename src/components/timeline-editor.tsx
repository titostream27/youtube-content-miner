'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

interface ClipData {
  id: number;
  videoId: string;
  title: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  endingType?: string | null;
  endingConfidence?: number | null;
  boundaryStatus?: string;
  boundaryConfidence?: number | null;
  nextTopicStartSec?: number | null;
  mainTopic?: string | null;
  suggestedHook?: string;
  suggestedCaption?: string;
}

interface Cue {
  startSec: number;
  endSec: number;
  text: string;
  speakerId?: string | null;
}

interface BoundaryReport {
  rough_start_sec: number;
  rough_end_sec: number;
  final_start_sec: number;
  final_end_sec: number;
  ending_type?: string;
  ending_complete?: boolean;
  boundary_status?: string;
  next_topic_start_sec?: number | null;
  next_topic_contamination?: number | null;
  main_topic?: string | null;
  topic_before?: string | null;
  topic_after?: string | null;
  feedback?: { id: number; original_start_sec: number; original_end_sec: number; new_start_sec: number; new_end_sec: number; reason: string | null }[];
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Transcript Timeline Editor (Master Task Brief §22).
 *
 * Shows the clip's transcript cues with the current boundary highlighted,
 * lets the editor drag start/end (via number inputs), approve/reject the AI
 * boundary, and persists manual corrections as clip_feedback.
 */
export default function TimelineEditor({ clipId }: { clipId: number }) {
  const router = useRouter();
  const [clip, setClip] = useState<ClipData | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [report, setReport] = useState<BoundaryReport | null>(null);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [clipRes, reportRes, transcriptRes] = await Promise.all([
          fetch(`/api/clips/${clipId}`),
          fetch(`/api/clips/${clipId}/boundary-report`),
          fetch(`/api/episodes/clip-transcript?clipId=${clipId}`).catch(() => null),
        ]);
        const clipData = (await clipRes.json()).clip;
        setClip(clipData);
        setStartSec(clipData.startSec);
        setEndSec(clipData.endSec);

        if (reportRes.ok) {
          setReport(await reportRes.json());
        }
        if (transcriptRes && transcriptRes.ok) {
          const t = await transcriptRes.json();
          setCues(t.cues ?? []);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [clipId]);

  const windowCues = useMemo(
    () => cues.filter((c) => c.startSec >= startSec - 3 && c.startSec < endSec + 3),
    [cues, startSec, endSec],
  );

  const saveBoundary = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/boundary`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_sec: startSec, end_sec: endSec, reason: reason || 'manual boundary adjustment' }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'save failed');
      } else {
        setMessage('Boundary saved + feedback recorded');
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }, [clipId, startSec, endSec, reason, router]);

  const refineBoundary = useCallback(async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/refine-boundary`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'refine failed');
      } else {
        setStartSec(body.startSec);
        setEndSec(body.endSec);
        setMessage(`Refined: ${body.boundaryStatus} — ${body.repairReason ?? 'ok'}`);
        const reportRes = await fetch(`/api/clips/${clipId}/boundary-report`);
        if (reportRes.ok) setReport(await reportRes.json());
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'refine failed');
    } finally {
      setSaving(false);
    }
  }, [clipId, router]);

  if (loading) return <div className="p-8 text-sm text-slate-400">Loading timeline…</div>;
  if (!clip) return <div className="p-8 text-sm text-slate-400">{error ?? 'Clip not found'}</div>;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">{clip.title}</h1>
        <p className="mt-1 text-sm text-slate-400">
          Transcript timeline editor — every correction is stored as feedback for the re-ranker.
        </p>
      </div>

      {error ? <div className="rounded-lg bg-rose-500/10 p-3 text-sm text-rose-300">{error}</div> : null}
      {message ? <div className="rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-300">{message}</div> : null}

      {/* Boundary controls */}
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Start (sec)
            <input
              type="number"
              step="0.1"
              value={startSec}
              onChange={(e) => setStartSec(Number(e.target.value))}
              className="w-28 rounded-md bg-slate-900 px-2 py-1.5 font-mono text-sm text-slate-100 ring-1 ring-inset ring-slate-600"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            End (sec)
            <input
              type="number"
              step="0.1"
              value={endSec}
              onChange={(e) => setEndSec(Number(e.target.value))}
              className="w-28 rounded-md bg-slate-900 px-2 py-1.5 font-mono text-sm text-slate-100 ring-1 ring-inset ring-slate-600"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-slate-400">
            Reason (optional)
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. removed interviewer interruption"
              className="w-full rounded-md bg-slate-900 px-2 py-1.5 text-sm text-slate-100 ring-1 ring-inset ring-slate-600"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={saveBoundary}
              disabled={saving}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save boundary'}
            </button>
            <button
              onClick={refineBoundary}
              disabled={saving}
              className="rounded-md bg-slate-700 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600 disabled:opacity-50"
            >
              Auto-refine
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-slate-400 sm:grid-cols-4">
          <div>Rough: {fmt(report?.rough_start_sec ?? clip.startSec)} – {fmt(report?.rough_end_sec ?? clip.endSec)}</div>
          <div>Final: {fmt(report?.final_start_sec ?? clip.startSec)} – {fmt(report?.final_end_sec ?? clip.endSec)}</div>
          <div>Ending: {report?.ending_type ?? clip.endingType ?? '—'}{report?.ending_complete === false ? ' (incomplete)' : ''}</div>
          <div>Next topic: {report?.next_topic_start_sec != null ? fmt(report.next_topic_start_sec) : '—'}</div>
        </div>
        {report?.main_topic ? <div className="mt-2 text-xs text-slate-400">Topic: {report.main_topic}</div> : null}
      </div>

      {/* Transcript timeline */}
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)] p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-200">Transcript timeline</h2>
        <div className="relative space-y-1">
          {/* Boundary bar */}
          <div
            className="absolute top-0 bottom-0 rounded-md bg-sky-500/15 ring-1 ring-sky-500/40"
            style={{
              left: `${Math.max(0, ((startSec - (startSec - 10)) / 20) * 100)}%`,
              width: `${Math.min(100, ((endSec - startSec) / 20) * 100)}%`,
            }}
          />
          {windowCues.map((cue, i) => {
            const inClip = cue.startSec >= startSec && cue.startSec < endSec;
            return (
              <div
                key={i}
                className={`relative flex gap-3 rounded px-2 py-1 text-sm ${
                  inClip ? 'bg-sky-500/10 text-slate-100' : 'text-slate-500'
                }`}
              >
                <span className="w-14 shrink-0 font-mono text-[11px] text-slate-400">{fmt(cue.startSec)}</span>
                <span className="flex-1">
                  {cue.text}
                  {cue.speakerId ? <span className="ml-2 text-[10px] text-amber-400">{cue.speakerId}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Click a cue? Use the number inputs to snap the boundary; then Save. Feedback history:
        </p>
        {report?.feedback && report.feedback.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs text-slate-400">
            {report.feedback.slice(0, 5).map((f) => (
              <li key={f.id}>
                {fmt(f.original_start_sec)}–{fmt(f.original_end_sec)} → {fmt(f.new_start_sec)}–{fmt(f.new_end_sec)}
                {f.reason ? ` · ${f.reason}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-slate-500">No manual corrections yet.</p>
        )}
      </div>
    </div>
  );
}
