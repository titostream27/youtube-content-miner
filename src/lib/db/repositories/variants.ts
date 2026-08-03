import { getDb, nowIso } from '@/lib/db/client';

/**
 * Phase 4 (Master Task Brief §36) — clip variants.
 *
 * For high-quality clips, generate up to three metadata variants:
 *   Hook A: outcome first
 *   Hook B: direct question
 *   Hook C: controversial statement
 *
 * Workflow: generate metadata variants -> choose one or two -> preview ->
 * final render selected variant -> publish -> track variant identity.
 */

export type VariantKey = 'hook_a' | 'hook_b' | 'hook_c';
export type VariantStatus = 'generated' | 'previewed' | 'selected' | 'published' | 'rejected';

export interface ClipVariant {
  id: number;
  clipId: number;
  variantKey: VariantKey;
  hook: string | null;
  title: string | null;
  captionEmphasis: string | null;
  layoutPreference: string | null;
  durationDeltaSec: number | null;
  status: VariantStatus;
  previewJobId: string | null;
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: number;
  clip_id: number;
  variant_key: string;
  hook: string | null;
  title: string | null;
  caption_emphasis: string | null;
  layout_preference: string | null;
  duration_delta_sec: number | null;
  status: string;
  preview_job_id: string | null;
  preview_url: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: Row): ClipVariant {
  return {
    id: r.id,
    clipId: r.clip_id,
    variantKey: r.variant_key as VariantKey,
    hook: r.hook,
    title: r.title,
    captionEmphasis: r.caption_emphasis,
    layoutPreference: r.layout_preference,
    durationDeltaSec: r.duration_delta_sec,
    status: r.status as VariantStatus,
    previewJobId: r.preview_job_id,
    previewUrl: r.preview_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function upsertVariant(input: {
  clipId: number;
  variantKey: VariantKey;
  hook?: string;
  title?: string;
  captionEmphasis?: string;
  layoutPreference?: string;
  durationDeltaSec?: number;
  status?: VariantStatus;
}): ClipVariant {
  const now = nowIso();
  const existing = getDb()
    .prepare('SELECT id FROM clip_variants WHERE clip_id = ? AND variant_key = ?')
    .get(input.clipId, input.variantKey) as { id: number } | undefined;

  if (existing) {
    getDb()
      .prepare(
        `UPDATE clip_variants
           SET hook = COALESCE(@hook, hook),
               title = COALESCE(@title, title),
               caption_emphasis = COALESCE(@captionEmphasis, caption_emphasis),
               layout_preference = COALESCE(@layoutPreference, layout_preference),
               duration_delta_sec = COALESCE(@durationDeltaSec, duration_delta_sec),
               status = COALESCE(@status, status),
               updated_at = @now
         WHERE clip_id = @clipId AND variant_key = @variantKey`,
      )
      .run({
        clipId: input.clipId,
        variantKey: input.variantKey,
        hook: input.hook ?? null,
        title: input.title ?? null,
        captionEmphasis: input.captionEmphasis ?? null,
        layoutPreference: input.layoutPreference ?? null,
        durationDeltaSec: input.durationDeltaSec ?? null,
        status: input.status ?? null,
        now,
      });
  } else {
    getDb()
      .prepare(
        `INSERT INTO clip_variants (clip_id, variant_key, hook, title, caption_emphasis, layout_preference, duration_delta_sec, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.clipId,
        input.variantKey,
        input.hook ?? null,
        input.title ?? null,
        input.captionEmphasis ?? null,
        input.layoutPreference ?? null,
        input.durationDeltaSec ?? null,
        input.status ?? 'generated',
        now,
        now,
      );
  }

  const row = getDb()
    .prepare('SELECT * FROM clip_variants WHERE clip_id = ? AND variant_key = ?')
    .get(input.clipId, input.variantKey) as Row;
  return mapRow(row);
}

export function listVariants(clipId: number): ClipVariant[] {
  const rows = getDb().prepare('SELECT * FROM clip_variants WHERE clip_id = ? ORDER BY id').all(clipId) as Row[];
  return rows.map(mapRow);
}

export function getVariant(clipId: number, variantKey: VariantKey): ClipVariant | null {
  const row = getDb()
    .prepare('SELECT * FROM clip_variants WHERE clip_id = ? AND variant_key = ?')
    .get(clipId, variantKey) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function updateVariantStatus(clipId: number, variantKey: VariantKey, status: VariantStatus): boolean {
  const result = getDb()
    .prepare('UPDATE clip_variants SET status = ?, updated_at = ? WHERE clip_id = ? AND variant_key = ?')
    .run(status, nowIso(), clipId, variantKey);
  return result.changes > 0;
}

export function updateVariantPreview(clipId: number, variantKey: VariantKey, jobId: string, url: string): boolean {
  const result = getDb()
    .prepare(
      'UPDATE clip_variants SET preview_job_id = ?, preview_url = ?, status = ?, updated_at = ? WHERE clip_id = ? AND variant_key = ?',
    )
    .run(jobId, url, 'previewed', nowIso(), clipId, variantKey);
  return result.changes > 0;
}

/** Select one variant as the active one (rejects the others). */
export function selectVariant(clipId: number, variantKey: VariantKey): boolean {
  const db = getDb();
  db.prepare("UPDATE clip_variants SET status = 'rejected', updated_at = ? WHERE clip_id = ? AND status != 'published'").run(nowIso(), clipId);
  return updateVariantStatus(clipId, variantKey, 'selected');
}
