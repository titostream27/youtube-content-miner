import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 3 (Master Task Brief §32) — semantic deduplication.
 *
 * Embeddings live in content_embeddings (vector = JSON float[]). When no
 * embedding provider is available we fall back to a lexical (Jaccard +
 * cosine-over-char-ngram) similarity — deterministic and provider-free.
 *
 * Rules:
 *   similarity >= 0.90              -> block as duplicate
 *   similarity 0.78 – 0.90          -> review as alternative angle
 *   same topic published recently   -> saturation penalty
 */

export const DUPLICATE_HARD_THRESHOLD = 0.9;
export const DUPLICATE_REVIEW_THRESHOLD = 0.78;
export const SATURATION_LOOKBACK_DAYS = 14;

export interface EmbeddingRecord {
  clipId: number;
  kind: string;
  text: string | null;
  vector: number[] | null;
  model: string | null;
}

interface Row {
  clip_id: number;
  kind: string;
  text: string | null;
  vector: string | null;
  model: string | null;
  created_at: string;
}

export function upsertEmbedding(input: {
  clipId: number;
  kind?: string;
  text?: string;
  vector?: number[];
  model?: string;
}): void {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO content_embeddings (clip_id, kind, text, vector, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(clip_id) DO UPDATE SET
         kind=excluded.kind, text=excluded.text, vector=excluded.vector,
         model=excluded.model, created_at=excluded.created_at`,
    )
    .run(
      input.clipId,
      input.kind ?? 'clip',
      input.text ?? null,
      input.vector ? JSON.stringify(input.vector) : null,
      input.model ?? null,
      now,
    );
}

export function getEmbedding(clipId: number): EmbeddingRecord | null {
  const row = getDb().prepare('SELECT * FROM content_embeddings WHERE clip_id = ?').get(clipId) as Row | undefined;
  if (!row) return null;
  let vector: number[] | null = null;
  if (row.vector) {
    try {
      vector = JSON.parse(row.vector);
    } catch {
      vector = null;
    }
  }
  return { clipId: row.clip_id, kind: row.kind, text: row.text, vector, model: row.model };
}

export function listEmbeddings(): EmbeddingRecord[] {
  const rows = getDb().prepare('SELECT * FROM content_embeddings ORDER BY clip_id').all() as Row[];
  return rows.map((row) => {
    let vector: number[] | null = null;
    if (row.vector) {
      try {
        vector = JSON.parse(row.vector);
      } catch {
        vector = null;
      }
    }
    return { clipId: row.clip_id, kind: row.kind, text: row.text, vector, model: row.model };
  });
}

/* ── Similarity ─────────────────────────────────────────────────────────── */

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) {
    if (b.has(w)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Char-ngram (2-3) cosine similarity — catches paraphrase where exact word
 * overlap fails. */
function ngramCosine(a: string, b: string): number {
  const grams = (s: string, n: number): Map<string, number> => {
    const clean = s.toLowerCase().replace(/\s+/g, ' ');
    const m = new Map<string, number>();
    for (let i = 0; i + n <= clean.length; i += 1) {
      const g = clean.slice(i, i + n);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a, 3);
  const gb = grams(b, 3);
  if (ga.size === 0 || gb.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of ga) {
    na += v * v;
    if (gb.has(k)) dot += v * (gb.get(k) ?? 0);
  }
  for (const v of gb.values()) nb += v * v;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Combined similarity: 60% word Jaccard + 40% ngram cosine. */
export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ja = jaccard(tokenize(a), tokenize(b));
  const ng = ngramCosine(a, b);
  return Math.round((0.6 * ja + 0.4 * ng) * 100) / 100;
}

export interface DedupResult {
  clipId: number;
  similarity: number;
  verdict: 'duplicate' | 'review' | 'ok';
}

/** Compare one clip's text against every other embedded clip. */
export function detectDuplicates(
  clipId: number,
  text: string,
  excludeClipIds: number[] = [],
): DedupResult[] {
  const results: DedupResult[] = [];
  for (const emb of listEmbeddings()) {
    if (emb.clipId === clipId) continue;
    if (excludeClipIds.includes(emb.clipId)) continue;
    if (!emb.text) continue;
    const sim = textSimilarity(text, emb.text);
    let verdict: DedupResult['verdict'] = 'ok';
    if (sim >= DUPLICATE_HARD_THRESHOLD) verdict = 'duplicate';
    else if (sim >= DUPLICATE_REVIEW_THRESHOLD) verdict = 'review';
    if (verdict !== 'ok' || sim >= DUPLICATE_REVIEW_THRESHOLD) {
      results.push({ clipId: emb.clipId, similarity: sim, verdict });
    }
  }
  return results.sort((a, b) => b.similarity - a.similarity);
}

/** True when the same topic was published within SATURATION_LOOKBACK_DAYS. */
export function recentlyPublishedSimilar(
  text: string,
  publishedClipTexts: { clipId: number; text: string; publishedAt: string }[],
): boolean {
  const cutoff = Date.now() - SATURATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  for (const p of publishedClipTexts) {
    const t = new Date(p.publishedAt).getTime();
    if (Number.isNaN(t) || t < cutoff) continue;
    if (textSimilarity(text, p.text) >= DUPLICATE_REVIEW_THRESHOLD) {
      return true;
    }
  }
  return false;
}
