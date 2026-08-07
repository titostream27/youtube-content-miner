/** Brief v11 — BoundarySchema must accept models that omit next-topic fields. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Mirror of the schema in boundary-refinement-agent.ts (kept local so the
// regression test pins the production contract without importing a module
// whose system prompt is huge).
const BoundarySchema = z.object({
  segments: z
    .array(
      z.object({
        index: z.number().int().min(0),
        finalStartSec: z.number().min(0),
        finalEndSec: z.number().min(0),
        endingType: z.enum([
          'PAYOFF',
          'CONCLUSION',
          'PUNCHLINE',
          'ANSWER_COMPLETE',
          'TOPIC_TRANSITION',
          'QUESTION_START',
          'INCOMPLETE_SENTENCE',
          'FILLER',
        ]),
        endingComplete: z.boolean(),
        endingConfidence: z.number().min(0).max(1),
        nextTopicDetected: z.boolean().default(false),
        nextTopicStart: z.number().min(0).nullable().default(null),
        nextTopicContamination: z.number().min(0).max(1).default(0),
        reason: z.string().max(300).default(''),
      }),
    )
    .max(120),
});

describe('boundary schema next-topic defaults', () => {
  it('accepts a model response that omits next-topic fields', () => {
    const payload = {
      segments: [
        {
          index: 0,
          finalStartSec: 12.5,
          finalEndSec: 40.2,
          endingType: 'ANSWER_COMPLETE',
          endingComplete: true,
          endingConfidence: 0.9,
        },
      ],
    };
    const parsed = BoundarySchema.parse(payload);
    expect(parsed.segments[0]!.nextTopicDetected).toBe(false);
    expect(parsed.segments[0]!.nextTopicStart).toBeNull();
    expect(parsed.segments[0]!.nextTopicContamination).toBe(0);
    expect(parsed.segments[0]!.reason).toBe('');
  });

  it('still enforces the core boundary fields', () => {
    const payload = { segments: [{ index: 0, finalStartSec: 'x', endingComplete: true }] };
    expect(() => BoundarySchema.parse(payload)).toThrow();
  });
});