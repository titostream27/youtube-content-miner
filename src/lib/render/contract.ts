import { z } from 'zod';
import type { ClipRecord } from '@/lib/db/repositories/clips';
import type { Transcript } from '@/lib/domain/types';

/**
 * Phase 2 (Renderer Integration) — Versioned render contract (brief §16-17).
 *
 * The miner decides WHAT and WHY; the renderer decides HOW. This module is
 * the miner-side half of the shared RenderRequestV2 contract. The renderer
 * validates the same shape (render_contract.py in the renderer repo).
 *
 * Contract rules (brief §17):
 * - Miner sends: clip boundary, narrative structure, caption text/timing,
 *   highlight terms, preferred layout, whether split is allowed, emphasis
 *   events, required output quality.
 * - Renderer decides: face coordinates, camera path, split timing, crop
 *   position, encoder settings, technical fallback layout.
 */

export const RenderRequestV2Schema = z.object({
  contract_version: z.literal('2.0'),
  request_id: z.string().min(1, 'request_id must be non-empty'),
  episode_id: z.string().min(1, 'episode_id must be non-empty'),
  video_url: z.string().url(),

  mode: z.enum(['preview', 'final']),

  source_preferences: z.object({
    max_height: z.number().int().min(0),
    prefer_best_available: z.boolean(),
  }),

  output: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive().optional(),
  }),

  clips: z
    .array(
      z.object({
        clip_id: z.union([z.string(), z.number()]),

        start_sec: z.number().min(0, 'start_sec must be >= 0'),
        end_sec: z.number(),

        title: z.string(),

        narrative: z.object({
          main_topic: z.string(),
          ending_type: z.string(),
          hook_end_sec: z.number().nullable(),
          payoff_start_sec: z.number().nullable(),
        }),

        layout_plan: z.object({
          preferred_layout: z.enum([
            'auto',
            'face_crop',
            'dual_face',
            'blur_background',
            'stacked_source',
            'screen_plus_face',
          ]),
          expected_speakers: z.number().int().min(0).nullable(),
          allow_split: z.boolean(),
          allow_blur_background: z.boolean(),
        }),

        caption_plan: z.object({
          language: z.string().min(1),
          provider: z.string().min(1).default('unknown'),
          transcript_version: z.string().default(''),
          alignment_confidence: z.number().min(0).max(1).default(0),
          cues: z.array(
            z.object({
              start_sec: z.number().min(0),
              end_sec: z.number(),
              text: z.string(),
              speaker_id: z.string().nullable().optional(),
              words: z
                .array(
                  z.object({
                    start_sec: z.number().min(0),
                    end_sec: z.number(),
                    text: z.string(),
                  }),
                )
                .optional(),
            }),
          ),
          highlight_terms: z.array(z.string()),
        }),

        editing_events: z.array(
          z.object({
            time_sec: z.number().min(0),
            type: z.enum(['emphasis', 'punchline', 'important_number', 'topic_label']),
            intensity: z.number().min(0).max(1),
          }),
        ),
      }),
    )
    .min(1, 'at least one clip is required'),
})
  // Phase 1 §5.5: cross-field rules shared with the JSON Schema and the
  // Python validator (render_contract.py).
  .superRefine((value, ctx) => {
    const seen = new Set<string | number>();
    value.clips.forEach((clip, idx) => {
      const path = ['clips', idx];
      // F19: finite numbers (no NaN/Infinity from JSON math).
      for (const key of ['start_sec', 'end_sec'] as const) {
        const n = clip[key];
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          ctx.addIssue({ code: 'custom', path: [...path, key], message: `${key} must be finite` });
        }
      }
      // F19: normalized clip_id — numeric IDs must be positive integers.
      if (typeof clip.clip_id === 'number' && (!Number.isInteger(clip.clip_id) || clip.clip_id <= 0)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'clip_id'],
          message: `clip_id must be a positive integer, got ${clip.clip_id}`,
        });
      }
      if (clip.end_sec <= clip.start_sec) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'end_sec'],
          message: `end_sec (${clip.end_sec}) must be > start_sec (${clip.start_sec})`,
        });
      }
      // Hardening v3 E2 (#27): normalize clip_id to a non-empty STRING key
      // before the duplicate check so "1" and 1 and "01" are all the same id.
      const normId = normalizeClipId(clip.clip_id);
      if (normId === '') {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'clip_id'],
          message: `clip_id must normalize to a non-empty string, got ${JSON.stringify(clip.clip_id)}`,
        });
      }
      if (seen.has(normId)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'clip_id'],
          message: `duplicate clip_id after normalization: ${normId}`,
        });
      }
      seen.add(normId);
      // F19: cues must be time-ordered and inside the clip range.
      let lastCueEnd = -Infinity;
      for (const [ci, cue] of clip.caption_plan.cues.entries()) {
        if (cue.start_sec < clip.start_sec || cue.end_sec > clip.end_sec) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'caption_plan', 'cues', ci],
            message: `caption cue [${cue.start_sec},${cue.end_sec}] outside clip range [${clip.start_sec},${clip.end_sec}]`,
          });
        }
        if (cue.end_sec <= cue.start_sec) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'caption_plan', 'cues', ci],
            message: `cue end_sec must be > start_sec`,
          });
        }
        if (cue.start_sec < lastCueEnd - 0.05) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'caption_plan', 'cues', ci],
            message: `cue [${cue.start_sec}] out of order (previous ended ${lastCueEnd})`,
          });
        }
        lastCueEnd = Math.max(lastCueEnd, cue.end_sec);
        // Hardening sprint P0.4: word-level timing must sit inside its cue.
        for (const [wi, word] of (cue.words ?? []).entries()) {
          if (word.start_sec < cue.start_sec || word.end_sec > cue.end_sec) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, 'caption_plan', 'cues', ci, 'words', wi],
              message: `word [${word.start_sec},${word.end_sec}] outside its cue [${cue.start_sec},${cue.end_sec}]`,
            });
          }
          if (word.end_sec <= word.start_sec) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, 'caption_plan', 'cues', ci, 'words', wi],
              message: 'word end_sec must be > start_sec',
            });
          }
        }
      }
      // F19: narrative ordering — payoff must come after the hook.
      const hookEnd = clip.narrative.hook_end_sec;
      const payoffStart = clip.narrative.payoff_start_sec;
      if (hookEnd != null && payoffStart != null && payoffStart < hookEnd) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'narrative'],
          message: `payoff_start_sec (${payoffStart}) must be >= hook_end_sec (${hookEnd})`,
        });
      }
      for (const [ei, ev] of clip.editing_events.entries()) {
        if (ev.time_sec < clip.start_sec || ev.time_sec > clip.end_sec) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'editing_events', ei],
            message: `editing event at ${ev.time_sec} outside clip range [${clip.start_sec},${clip.end_sec}]`,
          });
        }
      }
    });
  });

export type RenderRequestV2 = z.infer<typeof RenderRequestV2Schema>;

export interface BuildContractOptions {
  mode?: 'preview' | 'final';
  /** Optional highlight terms (e.g. punchline phrases) to emphasize. */
  highlightTerms?: string[];
  /** Optional narrative context from the boundary debug report. */
  mainTopic?: string | null;
  endingType?: string | null;
  /** Phase 2 (Canonical transcript): the transcript's real language. */
  language?: string;
  /** Phase 2: hook/payoff timing from the boundary report (absolute sec). */
  hookEndSec?: number | null;
  payoffStartSec?: number | null;
  /** Idempotency key (brief §20): render:<clip_id>:<contract_hash>:<mode>. */
  idempotencyKey?: string;
  /**
   * Hardening v3 E2 (#28): renderer algorithm version to salt the request
   * hash. A camera/caption/tracker/encoder change must not stay a permanent
   * idempotency/cache hit, so this version is folded into request_id. The
   * value itself is NOT sent in the payload — it only perturbs the hash.
   */
  renderProfileVersion?: string;
  /** Phase-2 (F17): canonical transcript for word-level caption cues. */
  transcript?: Transcript | null;
}

function cuesFromClip(
  clip: ClipRecord,
  transcript?: Transcript | null,
): {
  start_sec: number;
  end_sec: number;
  text: string;
  speaker_id?: string | null;
  words?: { start_sec: number; end_sec: number; text: string }[];
}[] {
  // Phase-2 correctness (F17): build cues from the CANONICAL transcript
  // (word timing + speaker metadata) when available, instead of inventing
  // evenly-spaced words from suggestedCaption.
  // Hardening sprint P0.4: propagate canonical word-level timing (c.words)
  // so the renderer can use it directly (no full re-transcription).
  if (transcript && transcript.cues.length > 0) {
    const cues = transcript.cues
      .filter((c) => c.startSec >= clip.startSec - 0.05 && c.startSec < clip.endSec)
      .map((c) => ({
        start_sec: round2(c.startSec),
        end_sec: round2(c.endSec),
        text: c.text.trim(),
        speaker_id: c.speakerId ?? null,
        words: (c.words ?? []).map((w) => ({
          start_sec: round2(w.startSec),
          end_sec: round2(w.endSec),
          text: w.text,
        })),
      }))
      .filter((c) => c.text.length > 0);
    if (cues.length > 0) return cues;
  }
  // Fallback: evenly spaced words from the suggested caption (hint only).
  if (!clip.suggestedCaption) return [];
  const words = clip.suggestedCaption.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const span = Math.max(0.5, clip.endSec - clip.startSec);
  const perWord = span / words.length;
  return words.map((text, i) => ({
    start_sec: round2(clip.startSec + i * perWord),
    end_sec: round2(clip.startSec + (i + 1) * perWord),
    text,
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Hardening v3 E2 (#27): normalize a numeric or string clip id to a canonical
 * non-empty string key for duplicate detection. Numeric 1 and "1" and "01"
 * collapse to the same id after normalization. */
function normalizeClipId(raw: string | number): string {
  const s = String(raw).trim();
  if (s === '') return '';
  // Numeric-looking ids ("1", "01", 1) normalize to canonical integer string.
  if (/^\d+$/.test(s)) {
    return String(parseInt(s, 10));
  }
  return s;
}

/**
 * Build a validated RenderRequestV2 payload for a batch of clips from the
 * same episode (brief §18: one request, one source download).
 */
export function buildRenderContract(
  videoId: string,
  clips: readonly ClipRecord[],
  options: BuildContractOptions = {},
): RenderRequestV2 {
  const mode = options.mode ?? 'final';
  const language = options.language ?? 'en';

  const payload: RenderRequestV2 = {
    contract_version: '2.0',
    // request_id is filled after the canonical hash is computed (F18).
    request_id: '',
    episode_id: videoId,
    video_url: `https://www.youtube.com/watch?v=${videoId}`,
    mode,
    source_preferences: {
      max_height: 2160,
      prefer_best_available: true,
    },
    output: mode === 'preview'
      ? { width: 540, height: 960 }
      : { width: 1080, height: 1920 },
    clips: clips.map((clip) => ({
      clip_id: clip.id,
      start_sec: round2(clip.startSec),
      end_sec: round2(clip.endSec),
      title: clip.title,
      narrative: {
        main_topic: options.mainTopic ?? clip.mainTopic ?? '',
        ending_type: options.endingType ?? clip.endingType ?? '',
        // Phase 2 (Canonical transcript): propagate hook/payoff timing.
        hook_end_sec: options.hookEndSec ?? null,
        payoff_start_sec: options.payoffStartSec ?? null,
      },
      layout_plan: {
        preferred_layout: 'auto',
        expected_speakers: null,
        allow_split: true,
        allow_blur_background: true,
      },
      caption_plan: {
        language,
        // Hardening sprint P0.4: caption provenance so the renderer knows
        // whether the timing is trusted (use directly) or needs a fallback.
        provider: options.transcript?.provider ?? 'unknown',
        transcript_version: options.transcript?.transcriptVersion ?? '',
        alignment_confidence: options.transcript?.alignmentConfidence ?? 0,
        cues: cuesFromClip(clip, options.transcript),
        highlight_terms: options.highlightTerms ?? [],
      },
      editing_events: [],
    })),
  };

  // Phase-2 correctness (F18): request_id hashes the FULL normalized
  // contract so any semantic change (boundaries, captions, narrative,
  // layout, mode) produces a different idempotency key. Only an explicit
  // idempotencyKey override keeps a stable id.
  if (options.idempotencyKey) {
    payload.request_id = options.idempotencyKey;
  } else {
    // Hardening v3 E2 (#28): fold the renderer profile version into the hash
    // so an algorithm change invalidates the idempotency key naturally.
    const profileSalt = options.renderProfileVersion ?? '';
    payload.request_id = `render:${contentHash(stableStringify(payload) + '|' + profileSalt)}`;
  }

  return RenderRequestV2Schema.parse(payload);
}

/** Deterministic, key-sorted JSON (F18): nested keys sorted recursively so
 * equivalent contracts hash identically regardless of insertion order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic content hash (F18): full normalized contract -> 16 hex. */
function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
