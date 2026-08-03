import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 3 (Master Task Brief §31) — comment mining.
 *
 * Samples of comments are parsed for:
 *   timestamp mentions, frequently quoted statements, repeated questions,
 *   controversial claims, audience language, audience objections,
 *   requested follow-up topics.
 *
 * Timestamps are stored in ABSOLUTE seconds (HH:MM:SS and MM:SS forms).
 */

export type CommentSignalKind =
  | 'timestamp_mention'
  | 'repeated_question'
  | 'controversial_claim'
  | 'audience_language'
  | 'objection'
  | 'follow_up_topic'
  | 'quoted_statement';

export interface CommentSignal {
  id: number;
  videoId: string;
  clipId: number | null;
  kind: CommentSignalKind;
  payload: Record<string, unknown>;
  confidence: number;
  createdAt: string;
}

interface SignalRow {
  id: number;
  video_id: string;
  clip_id: number | null;
  kind: string;
  payload: string;
  confidence: number;
  created_at: string;
}

function mapRow(r: SignalRow): CommentSignal {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = { raw: r.payload };
  }
  return {
    id: r.id,
    videoId: r.video_id,
    clipId: r.clip_id,
    kind: r.kind as CommentSignalKind,
    payload,
    confidence: r.confidence,
    createdAt: r.created_at,
  };
}

export function insertCommentSignal(input: {
  videoId: string;
  clipId?: number | null;
  kind: CommentSignalKind;
  payload: Record<string, unknown>;
  confidence?: number;
}): CommentSignal {
  getDb()
    .prepare(
      `INSERT INTO comment_signals (video_id, clip_id, kind, payload, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.videoId,
      input.clipId ?? null,
      input.kind,
      JSON.stringify(input.payload),
      input.confidence ?? 0.5,
      nowIso(),
    );
  const row = getDb().prepare('SELECT * FROM comment_signals WHERE id = last_insert_rowid()').get() as SignalRow;
  return mapRow(row);
}

export function listCommentSignals(videoId: string): CommentSignal[] {
  const rows = getDb()
    .prepare('SELECT * FROM comment_signals WHERE video_id = ? ORDER BY id DESC LIMIT 500')
    .all(videoId) as SignalRow[];
  return rows.map(mapRow);
}

export function clearCommentSignals(videoId: string): void {
  getDb().prepare('DELETE FROM comment_signals WHERE video_id = ?').run(videoId);
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

const TIMESTAMP_RE = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;

/** Extract absolute seconds for "12:34" and "1:02:03" mentions. */
function extractTimestamps(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(TIMESTAMP_RE)) {
    const h = m[1] ? Number.parseInt(m[1], 10) : 0;
    const minStr = m[2];
    const secStr = m[3];
    if (!minStr || !secStr) continue;
    const min = Number.parseInt(minStr, 10);
    const sec = Number.parseInt(secStr, 10);
    if (min > 59 || sec > 59) continue;
    const total = h * 3600 + min * 60 + sec;
    if (total > 0 && total < 4 * 3600) out.push(total);
  }
  return out;
}

const QUESTION_RE = /\b(how|what|why|when|where|who|is there|can you|do you|should|does)\b.*\?/i;

const OBJECTION_RE = /\b(disagree|wrong|not true|false|misleading|biased|clickbait|hate|don't believe|untrue)\b/i;

const CONTROVERSY_RE = /\b(controversial|scandal|liar|fake|hoax|bs|bullshit|outrage|boycott|debunk)\b/i;

const FOLLOW_UP_RE = /\b(part 2|next part|follow up|more on|continue|when will you)\b/i;

const QUOTE_RE = /["“”']([^"“”']{8,})["“”']/g;

const LANG_MARKERS: { lang: string; re: RegExp }[] = [
  { lang: 'en', re: /\b(the|and|you|this|that|with)\b/i },
  { lang: 'id', re: /\b(yang|dan|saya|ini|itu|dengan)\b/i },
  { lang: 'de', re: /\b(der|die|das|und|nicht|ich)\b/i },
  { lang: 'fr', re: /\b(le|la|les|est|je|pas)\b/i },
  { lang: 'it', re: /\b(il|lo|non|che|per)\b/i },
];

export interface CommentMiningResult {
  videoId: string;
  sampleSize: number;
  timestampMentions: { timeSec: number; mentionCount: number }[];
  repeatedQuestions: { text: string; count: number }[];
  quotedStatements: { text: string; count: number }[];
  objections: number;
  controversyScore: number;
  followUpTopics: { text: string; count: number }[];
  audienceLanguages: { lang: string; count: number }[];
}

function normalizeComment(c: string): string {
  return c.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a batch of raw comments into structured signals (brief §31).
 * Aggregates repeated questions/statements by exact-normalized text.
 */
export function mineComments(videoId: string, comments: string[]): CommentMiningResult {
  const clean = comments.map(normalizeComment).filter(Boolean);
  const sampleSize = clean.length;

  const tsCounts = new Map<number, number>();
  const questionCounts = new Map<string, number>();
  const quoteCounts = new Map<string, number>();
  const followUpCounts = new Map<string, number>();
  const langCounts = new Map<string, number>();
  let objections = 0;
  let controversy = 0;

  for (const c of clean) {
    // Timestamps.
    for (const t of extractTimestamps(c)) {
      tsCounts.set(t, (tsCounts.get(t) ?? 0) + 1);
    }
    // Questions.
    if (QUESTION_RE.test(c)) {
      const q = c.slice(0, 120).trim();
      questionCounts.set(q, (questionCounts.get(q) ?? 0) + 1);
    }
    // Quoted statements.
    for (const m of c.matchAll(QUOTE_RE)) {
      const q = m[1]!.trim().slice(0, 120);
      if (q.length > 3) quoteCounts.set(q, (quoteCounts.get(q) ?? 0) + 1);
    }
    // Follow-ups.
    if (FOLLOW_UP_RE.test(c)) {
      const f = c.slice(0, 120).trim();
      followUpCounts.set(f, (followUpCounts.get(f) ?? 0) + 1);
    }
    // Objections / controversy.
    if (OBJECTION_RE.test(c)) objections += 1;
    if (CONTROVERSY_RE.test(c)) controversy += 1;
    // Language (first match).
    for (const m of LANG_MARKERS) {
      if (m.re.test(c)) {
        langCounts.set(m.lang, (langCounts.get(m.lang) ?? 0) + 1);
        break;
      }
    }
  }

  const toSorted = <K,>(map: Map<K, number>): { key: K; count: number }[] =>
    [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);

  const timestampMentions = toSorted(tsCounts)
    .filter((x) => x.count >= 1)
    .slice(0, 20)
    .map((x) => ({ timeSec: Number(x.key), mentionCount: x.count }));

  const repeatedQuestions = toSorted(questionCounts)
    .filter((x) => x.count >= 2)
    .slice(0, 10)
    .map((x) => ({ text: String(x.key), count: x.count }));

  const quotedStatements = toSorted(quoteCounts)
    .filter((x) => x.count >= 2)
    .slice(0, 10)
    .map((x) => ({ text: String(x.key), count: x.count }));

  const followUpTopics = toSorted(followUpCounts)
    .filter((x) => x.count >= 2)
    .slice(0, 5)
    .map((x) => ({ text: String(x.key), count: x.count }));

  const audienceLanguages = toSorted(langCounts).map((x) => ({ lang: String(x.key), count: x.count }));

  const controversyScore = sampleSize > 0 ? Math.min(1, controversy / Math.max(1, sampleSize * 0.2)) : 0;

  return {
    videoId,
    sampleSize,
    timestampMentions,
    repeatedQuestions,
    quotedStatements,
    objections,
    controversyScore: Math.round(controversyScore * 100) / 100,
    followUpTopics,
    audienceLanguages,
  };
}

/** Persist the mining result as signal rows (idempotent per video: clears first). */
export function persistCommentSignals(result: CommentMiningResult): number {
  clearCommentSignals(result.videoId);
  let inserted = 0;

  for (const ts of result.timestampMentions) {
    insertCommentSignal({
      videoId: result.videoId,
      kind: 'timestamp_mention',
      payload: { timeSec: ts.timeSec, mentionCount: ts.mentionCount },
      confidence: Math.min(1, ts.mentionCount / 5),
    });
    inserted += 1;
  }
  for (const q of result.repeatedQuestions) {
    insertCommentSignal({
      videoId: result.videoId,
      kind: 'repeated_question',
      payload: { text: q.text, count: q.count },
      confidence: Math.min(1, q.count / 3),
    });
    inserted += 1;
  }
  for (const s of result.quotedStatements) {
    insertCommentSignal({
      videoId: result.videoId,
      kind: 'quoted_statement',
      payload: { text: s.text, count: s.count },
      confidence: 0.5,
    });
    inserted += 1;
  }
  for (const f of result.followUpTopics) {
    insertCommentSignal({
      videoId: result.videoId,
      kind: 'follow_up_topic',
      payload: { text: f.text, count: f.count },
      confidence: 0.5,
    });
    inserted += 1;
  }
  if (result.objections > 0) {
    insertCommentSignal({
      videoId: result.videoId,
      kind: 'objection',
      payload: { count: result.objections },
      confidence: Math.min(1, result.objections / 10),
    });
    inserted += 1;
  }
  if (result.controversyScore > 0) {
    insertCommentSignal({
      videoId: result.videoId,
      kind: 'controversial_claim',
      payload: { controversyScore: result.controversyScore },
      confidence: result.controversyScore,
    });
    inserted += 1;
  }
  for (const l of result.audienceLanguages.slice(0, 3)) {
    insertCommentSignal({
      videoId: result.videoId,
      kind: 'audience_language',
      payload: { lang: l.lang, count: l.count },
      confidence: Math.min(1, l.count / 5),
    });
    inserted += 1;
  }

  return inserted;
}
