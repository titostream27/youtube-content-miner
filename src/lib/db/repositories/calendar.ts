import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 3 (Master Task Brief §35) — content calendar (scheduling) and
 * §33 — portfolio planning suggestions.
 *
 * Scheduling uses explicit timezone offsets in the ISO timestamp
 * (e.g. 2026-08-05T19:00:00-04:00), never local time without tz.
 */

/* ── Content calendar ───────────────────────────────────────────────────── */

export interface CalendarEntryInput {
  clipId: number;
  scheduledAt: string; // ISO with tz offset
  targetMarket: string;
  status?: 'scheduled' | 'paused' | 'published' | 'cancelled';
  slotLabel?: string;
  reason?: string;
}

export interface CalendarEntry extends CalendarEntryInput {
  id: number;
  createdAt: string;
  updatedAt: string;
}

interface CalRow {
  id: number;
  clip_id: number;
  scheduled_at: string;
  target_market: string;
  status: string;
  slot_label: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function mapCal(r: CalRow): CalendarEntry {
  return {
    id: r.id,
    clipId: r.clip_id,
    scheduledAt: r.scheduled_at,
    targetMarket: r.target_market,
    status: r.status as CalendarEntry['status'],
    slotLabel: r.slot_label ?? undefined,
    reason: r.reason ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function scheduleClip(input: CalendarEntryInput): CalendarEntry {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO content_calendar (clip_id, scheduled_at, target_market, status, slot_label, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.clipId,
      input.scheduledAt,
      input.targetMarket,
      input.status ?? 'scheduled',
      input.slotLabel ?? null,
      input.reason ?? null,
      now,
      now,
    );
  const row = getDb().prepare('SELECT * FROM content_calendar WHERE id = last_insert_rowid()').get() as CalRow;
  return mapCal(row);
}

export function updateCalendarEntry(
  id: number,
  patch: Partial<Pick<CalendarEntryInput, 'status' | 'scheduledAt' | 'reason'>>,
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE content_calendar
         SET status = COALESCE(@status, status),
             scheduled_at = COALESCE(@scheduledAt, scheduled_at),
             reason = COALESCE(@reason, reason),
             updated_at = @now
       WHERE id = @id`,
    )
    .run({ id, status: patch.status ?? null, scheduledAt: patch.scheduledAt ?? null, reason: patch.reason ?? null, now: nowIso() });
  return result.changes > 0;
}

export function listCalendar(from?: string, to?: string): CalendarEntry[] {
  let sql = 'SELECT * FROM content_calendar';
  const params: (string | number)[] = [];
  if (from && to) {
    sql += ' WHERE scheduled_at >= ? AND scheduled_at <= ?';
    params.push(from, to);
  }
  sql += ' ORDER BY scheduled_at ASC';
  const rows = getDb().prepare(sql).all(...params) as CalRow[];
  return rows.map(mapCal);
}

export function getCalendarEntryByClip(clipId: number): CalendarEntry | null {
  const row = getDb()
    .prepare('SELECT * FROM content_calendar WHERE clip_id = ? ORDER BY id DESC LIMIT 1')
    .get(clipId) as CalRow | undefined;
  return row ? mapCal(row) : null;
}

/* ── Portfolio suggestions (brief §33) ──────────────────────────────────── */

export interface PortfolioSuggestionInput {
  week: string;
  clipId: number;
  slot: string;
  reason: string;
  status?: 'suggested' | 'approved' | 'rejected';
}

export interface PortfolioSuggestion extends PortfolioSuggestionInput {
  id: number;
  createdAt: string;
}

interface PortRow {
  id: number;
  week: string;
  clip_id: number;
  slot: string;
  reason: string;
  status: string;
  created_at: string;
}

export function insertPortfolioSuggestion(input: PortfolioSuggestionInput): PortfolioSuggestion {
  getDb()
    .prepare(
      `INSERT INTO portfolio_suggestions (week, clip_id, slot, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.week, input.clipId, input.slot, input.reason, input.status ?? 'suggested', nowIso());
  const row = getDb().prepare('SELECT * FROM portfolio_suggestions WHERE id = last_insert_rowid()').get() as PortRow;
  return { id: row.id, week: row.week, clipId: row.clip_id, slot: row.slot, reason: row.reason, status: row.status as PortfolioSuggestion['status'], createdAt: row.created_at };
}

export function listPortfolioSuggestions(week: string): PortfolioSuggestion[] {
  const rows = getDb()
    .prepare('SELECT * FROM portfolio_suggestions WHERE week = ? ORDER BY id')
    .all(week) as PortRow[];
  return rows.map((r) => ({ id: r.id, week: r.week, clipId: r.clip_id, slot: r.slot, reason: r.reason, status: r.status as PortfolioSuggestion['status'], createdAt: r.created_at }));
}

export function updatePortfolioSuggestion(id: number, status: 'approved' | 'rejected'): boolean {
  const result = getDb().prepare('UPDATE portfolio_suggestions SET status = ? WHERE id = ?').run(status, id);
  return result.changes > 0;
}

/** Clear suggestions for a week (regenerate flow). */
export function clearPortfolioSuggestions(week: string): void {
  getDb().prepare('DELETE FROM portfolio_suggestions WHERE week = ?').run(week);
}
