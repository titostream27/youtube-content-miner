import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 2 (Master Task Brief §22/§45) — manual boundary feedback.
 *
 * Every manual boundary correction is stored so the AI can learn from
 * human review: verdict + original/new boundaries + reason.
 */

export interface BoundaryFeedback {
  id: number;
  clipId: number;
  feedbackId: number | null;
  originalStartSec: number;
  originalEndSec: number;
  newStartSec: number;
  newEndSec: number;
  reason: string | null;
  createdAt: string;
}

interface Row {
  id: number;
  clip_id: number;
  feedback_id: number | null;
  original_start_sec: number;
  original_end_sec: number;
  new_start_sec: number;
  new_end_sec: number;
  reason: string | null;
  created_at: string;
}

function mapRow(r: Row): BoundaryFeedback {
  return {
    id: r.id,
    clipId: r.clip_id,
    feedbackId: r.feedback_id,
    originalStartSec: r.original_start_sec,
    originalEndSec: r.original_end_sec,
    newStartSec: r.new_start_sec,
    newEndSec: r.new_end_sec,
    reason: r.reason,
    createdAt: r.created_at,
  };
}

export function addBoundaryFeedback(input: {
  clipId: number;
  originalStartSec: number;
  originalEndSec: number;
  newStartSec: number;
  newEndSec: number;
  reason?: string;
}): BoundaryFeedback {
  // Also insert a row in the legacy clip_feedback table (verdict boundary_adjusted).
  const fb = getDb()
    .prepare('INSERT INTO clip_feedback (clip_id, verdict, note, created_at) VALUES (?, ?, ?, ?)')
    .run(input.clipId, 'boundary_adjusted', input.reason ?? null, nowIso());
  const feedbackId = Number(fb.lastInsertRowid);

  getDb()
    .prepare(
      `INSERT INTO clip_feedback_boundary (clip_id, feedback_id, original_start_sec, original_end_sec, new_start_sec, new_end_sec, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.clipId,
      feedbackId,
      input.originalStartSec,
      input.originalEndSec,
      input.newStartSec,
      input.newEndSec,
      input.reason ?? null,
      nowIso(),
    );
  const row = getDb().prepare('SELECT * FROM clip_feedback_boundary WHERE id = last_insert_rowid()').get() as Row;
  return mapRow(row);
}

export function listBoundaryFeedback(clipId: number): BoundaryFeedback[] {
  const rows = getDb()
    .prepare('SELECT * FROM clip_feedback_boundary WHERE clip_id = ? ORDER BY id DESC')
    .all(clipId) as Row[];
  return rows.map(mapRow);
}

export function countBoundaryFeedback(clipId: number): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM clip_feedback_boundary WHERE clip_id = ?').get(clipId) as { c: number };
  return row.c;
}

/** Phase 2 (Confidence calibration): all labelled editor samples joined to
 * the clip's predicted confidence, ready for calibrateConfidence(). */
export function listCalibrationSamples(limit = 500): {
  clipId: number;
  confidence: number;
  verdict: 'approved' | 'rejected' | 'boundary_adjusted';
  boundaryShiftSec: number;
}[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id AS clip_id, c.confidence AS confidence, f.verdict AS verdict,
              ABS(COALESCE(fb.new_start_sec, c.start_sec) - c.start_sec)
            + ABS(COALESCE(fb.new_end_sec, c.end_sec) - c.end_sec) AS boundary_shift_sec
         FROM clip_feedback f
         JOIN clips c ON c.id = f.clip_id
         LEFT JOIN clip_feedback_boundary fb ON fb.feedback_id = f.id
        ORDER BY f.id DESC
        LIMIT ?`,
    )
    .all(limit) as {
    clip_id: number;
    confidence: number;
    verdict: string;
    boundary_shift_sec: number | null;
  }[];
  return rows.map((r) => ({
    clipId: r.clip_id,
    confidence: r.confidence,
    verdict: (['approved', 'rejected', 'boundary_adjusted'].includes(r.verdict)
      ? r.verdict
      : 'boundary_adjusted') as 'approved' | 'rejected' | 'boundary_adjusted',
    boundaryShiftSec: r.boundary_shift_sec ?? 0,
  }));
}
