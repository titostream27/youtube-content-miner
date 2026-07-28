import type { Transcript, TranscriptCue, TranscriptSource } from '@/lib/domain/types';
import { fromJson, getDb, nowIso, toJson } from '../client';

interface TranscriptRow {
  video_id: string;
  source: string;
  language: string;
  duration_sec: number;
  word_count: number;
  cues: string;
  fetched_at: string;
}

/**
 * Transcript cache. Fetching or generating a transcript is the single most
 * expensive operation in the pipeline, so it happens at most once per video
 * even across many runs.
 */
export function saveTranscript(transcript: Transcript): void {
  getDb()
    .prepare(
      `INSERT INTO transcripts (video_id, source, language, duration_sec, word_count, cues, fetched_at)
       VALUES (@videoId, @source, @language, @durationSec, @wordCount, @cues, @fetchedAt)
       ON CONFLICT (video_id) DO UPDATE SET
         source       = excluded.source,
         language     = excluded.language,
         duration_sec = excluded.duration_sec,
         word_count   = excluded.word_count,
         cues         = excluded.cues,
         fetched_at   = excluded.fetched_at`,
    )
    .run({
      videoId: transcript.videoId,
      source: transcript.source,
      language: transcript.language,
      durationSec: transcript.durationSec,
      wordCount: transcript.wordCount,
      cues: toJson(transcript.cues),
      fetchedAt: nowIso(),
    });
}

export function getTranscript(videoId: string): Transcript | null {
  const row = getDb()
    .prepare('SELECT * FROM transcripts WHERE video_id = ?')
    .get(videoId) as TranscriptRow | undefined;

  if (!row) return null;

  return {
    videoId: row.video_id,
    source: row.source as TranscriptSource,
    language: row.language,
    durationSec: row.duration_sec,
    wordCount: row.word_count,
    cues: fromJson<TranscriptCue[]>(row.cues, []),
  };
}

export function hasTranscript(videoId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS present FROM transcripts WHERE video_id = ?')
    .get(videoId) as { present: number } | undefined;
  return Boolean(row);
}
