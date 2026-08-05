import { z } from 'zod';
import type { ClipRecord } from '@/lib/db/repositories/clips';

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
          cues: z.array(
            z.object({
              start_sec: z.number().min(0),
              end_sec: z.number(),
              text: z.string(),
              speaker_id: z.string().nullable().optional(),
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
      if (clip.end_sec <= clip.start_sec) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'end_sec'],
          message: `end_sec (${clip.end_sec}) must be > start_sec (${clip.start_sec})`,
        });
      }
      if (seen.has(clip.clip_id)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'clip_id'],
          message: `duplicate clip_id ${clip.clip_id}`,
        });
      }
      seen.add(clip.clip_id);
      for (const [ci, cue] of clip.caption_plan.cues.entries()) {
        if (cue.start_sec < clip.start_sec || cue.end_sec > clip.end_sec) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'caption_plan', 'cues', ci],
            message: `caption cue [${cue.start_sec},${cue.end_sec}] outside clip range [${clip.start_sec},${clip.end_sec}]`,
          });
        }
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
  /** Idempotency key (brief §20): render:<clip_id>:<contract_hash>:<mode>. */
  idempotencyKey?: string;
}

function cuesFromClip(clip: ClipRecord): { start_sec: number; end_sec: number; text: string; speaker_id?: string | null }[] {
  // Clip caption cues come from the clip transcript range; for the renderer
  // the captions are re-derived by whisper anyway, so we only send cues when
  // a suggested caption exists (used as a hint).
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
  const requestId =
    options.idempotencyKey ??
    `render:${videoId}:${mode}:${clips.map((c) => c.id).join('-')}:${clips
      .map((c) => `${round2(c.startSec)}-${round2(c.endSec)}`)
      .join(',')}`;

  const payload: RenderRequestV2 = {
    contract_version: '2.0',
    request_id: requestId,
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
        hook_end_sec: null,
        payoff_start_sec: null,
      },
      layout_plan: {
        preferred_layout: 'auto',
        expected_speakers: null,
        allow_split: true,
        allow_blur_background: true,
      },
      caption_plan: {
        language: 'en',
        cues: cuesFromClip(clip),
        highlight_terms: options.highlightTerms ?? [],
      },
      editing_events: [],
    })),
  };

  return RenderRequestV2Schema.parse(payload);
}
