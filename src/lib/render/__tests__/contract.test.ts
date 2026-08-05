import { describe, it, expect } from 'vitest';
import { buildRenderContract, RenderRequestV2Schema } from '@/lib/render/contract';
import type { ClipRecord } from '@/lib/db/repositories/clips';

function fakeClip(overrides: Partial<ClipRecord> = {}): ClipRecord {
  return {
    id: 12,
    videoId: 'ep-1',
    runId: 1,
    segmentIndex: 0,
    title: 'Test clip',
    startSec: 124.3,
    endSec: 157.8,
    durationSec: 33.5,
    finalScore: 92,
    confidence: 0.9,
    tier: 'high_priority',
    category: 'Story',
    dimensions: { hook: 0.8, standalone: 0.7, clarity: 0.9, curiosity: 0.6, emotion: 0.5, storytelling: 0.8, shareability: 0.7, controversy: 0.3, teachingValue: 0.6, entertainment: 0.7 },
    whyThisWorks: ['clean story with a payoff'],
    suggestedHook: 'Most companies fail',
    suggestedCaption: 'Expansion multiplied a broken model.',
    editingNotes: '',
    transcript: 'text',
    engine: 'heuristic',
    status: 'new',
    license: 'creativeCommon',
    renderStatus: 'none',
    renderJobId: null,
    renderPath: null,
    renderError: null,
    seoTitle: null,
    seoDescription: null,
    seoTags: [],
    seoGeneratedAt: null,
    publishStatus: 'none',
    publishUrl: null,
    publishError: null,
    publishedAt: null,
    endingType: 'CONCLUSION',
    endingConfidence: 0.82,
    nextTopicRemoved: true,
    nextTopicStartSec: 159.1,
    nextTopicContamination: 0.04,
    boundaryStatus: 'refined',
    boundaryConfidence: 0.82,
    startComplete: true,
    endingComplete: true,
    repairReason: null,
    roughStartSec: 120,
    roughEndSec: 168,
    mainTopic: 'why expansion failed',
    topicBefore: 'product launch',
    topicAfter: 'moving to Australia',
    rightsStatus: 'unknown',
    rightsNotes: null,
    qcStatus: 'pending',
    qcScore: null,
    scheduledAt: null,
    targetMarket: null,
    idempotencyKey: null,
    ...overrides,
  } as ClipRecord;
}

/**
 * A fully-populated VALID v2 payload. Every field the schema requires is
 * present so a failing test fails for the intended reason only.
 */
function makeV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const valid = {
    contract_version: '2.0',
    request_id: 'req-1',
    episode_id: 'ep-1',
    video_url: 'https://youtube.com/watch?v=abc',
    mode: 'final',
    source_preferences: { max_height: 2160, prefer_best_available: true },
    output: { width: 1080, height: 1920 },
    clips: [
      {
        clip_id: 1,
        start_sec: 1.0,
        end_sec: 5.0,
        title: 't',
        narrative: { main_topic: 'm', ending_type: 'c', hook_end_sec: null, payoff_start_sec: null },
        layout_plan: { preferred_layout: 'auto', expected_speakers: null, allow_split: true, allow_blur_background: true },
        caption_plan: { language: 'en', cues: [], highlight_terms: [] },
        editing_events: [],
      },
    ],
  };
  return { ...valid, ...overrides };
}

describe('buildRenderContract (brief §16-17)', () => {
  it('produces a valid v2.0 contract', () => {
    const contract = buildRenderContract('ep-1', [fakeClip()]);
    expect(contract.contract_version).toBe('2.0');
    expect(() => RenderRequestV2Schema.parse(contract)).not.toThrow();
  });

  it('carries clip boundaries and narrative', () => {
    const contract = buildRenderContract('ep-1', [fakeClip()]);
    const clip = contract.clips[0]!;
    expect(clip.clip_id).toBe(12);
    expect(clip.start_sec).toBeCloseTo(124.3);
    expect(clip.end_sec).toBeCloseTo(157.8);
    expect(clip.narrative.main_topic).toBe('why expansion failed');
    expect(clip.narrative.ending_type).toBe('CONCLUSION');
  });

  it('defaults layout to auto + allows split', () => {
    const contract = buildRenderContract('ep-1', [fakeClip()]);
    const clip = contract.clips[0]!;
    expect(clip.layout_plan.preferred_layout).toBe('auto');
    expect(clip.layout_plan.allow_split).toBe(true);
    expect(clip.layout_plan.allow_blur_background).toBe(true);
  });

  it('switches output size for preview mode (brief §21)', () => {
    const finalC = buildRenderContract('ep-1', [fakeClip()], { mode: 'final' });
    expect(finalC.output).toEqual({ width: 1080, height: 1920 });
    const previewC = buildRenderContract('ep-1', [fakeClip()], { mode: 'preview' });
    expect(previewC.output).toEqual({ width: 540, height: 960 });
    expect(previewC.mode).toBe('preview');
  });

  it('generates caption cues from suggested caption', () => {
    const contract = buildRenderContract('ep-1', [fakeClip()]);
    const cues = contract.clips[0]!.caption_plan.cues;
    expect(cues.length).toBeGreaterThan(0);
    expect(cues[0]!.text).toBeTruthy();
    // Cues stay inside the clip window.
    for (const cue of cues) {
      expect(cue.start_sec).toBeGreaterThanOrEqual(124.3);
      expect(cue.end_sec).toBeLessThanOrEqual(157.8);
    }
  });

  it('is idempotent: same clips + same options -> same request_id', () => {
    const a = buildRenderContract('ep-1', [fakeClip()]);
    const b = buildRenderContract('ep-1', [fakeClip()]);
    expect(a.request_id).toBe(b.request_id);
    expect(a.request_id).toContain('render:');
  });

  it('handles a batch of clips (brief §18)', () => {
    const contract = buildRenderContract('ep-1', [fakeClip({ id: 12 }), fakeClip({ id: 14, startSec: 440.2, endSec: 477.9 })]);
    expect(contract.clips).toHaveLength(2);
    expect(contract.video_url).toContain('ep-1');
  });

  it('propagates transcript language (Phase 2 canonical transcript)', () => {
    const contract = buildRenderContract('ep-1', [fakeClip()], { language: 'id' });
    expect(contract.clips[0]!.caption_plan.language).toBe('id');
  });

  it('propagates hook/payoff timing (Phase 2 canonical transcript)', () => {
    const contract = buildRenderContract('ep-1', [fakeClip()], {
      hookEndSec: 128.0,
      payoffStartSec: 150.0,
    });
    expect(contract.clips[0]!.narrative.hook_end_sec).toBe(128.0);
    expect(contract.clips[0]!.narrative.payoff_start_sec).toBe(150.0);
  });
});

describe('RenderRequestV2Schema contract rules (Phase 1 §5.5)', () => {
  it('accepts the fully-valid base payload', () => {
    expect(() => RenderRequestV2Schema.parse(makeV2())).not.toThrow();
  });

  it('rejects non-2.0 contract_version', () => {
    expect(() => RenderRequestV2Schema.parse(makeV2({ contract_version: '1.0' }))).toThrow();
  });

  it('rejects empty request_id', () => {
    expect(() => RenderRequestV2Schema.parse(makeV2({ request_id: '' }))).toThrow();
  });

  it('rejects invalid mode', () => {
    expect(() => RenderRequestV2Schema.parse(makeV2({ mode: 'draft' }))).toThrow();
  });

  it('rejects negative start_sec', () => {
    const clips = [{ ...(makeV2().clips as any[])[0], start_sec: -1 }];
    expect(() => RenderRequestV2Schema.parse(makeV2({ clips }))).toThrow();
  });

  it('rejects end_sec <= start_sec', () => {
    const clips = [{ ...(makeV2().clips as any[])[0], start_sec: 5.0, end_sec: 5.0 }];
    expect(() => RenderRequestV2Schema.parse(makeV2({ clips }))).toThrow();
  });

  it('rejects caption cue outside clip range', () => {
    const clips = [{
      ...(makeV2().clips as any[])[0],
      caption_plan: { language: 'en', highlight_terms: [], cues: [{ start_sec: 6.0, end_sec: 7.0, text: 'late' }] },
    }];
    expect(() => RenderRequestV2Schema.parse(makeV2({ clips }))).toThrow();
  });

  it('rejects duplicate clip_ids', () => {
    const clip = (makeV2().clips as any[])[0];
    const clips = [clip, { ...clip, start_sec: 6.0, end_sec: 7.0 }];
    expect(() => RenderRequestV2Schema.parse(makeV2({ clips }))).toThrow();
  });

  it('rejects invalid preferred_layout enum', () => {
    const clips = [{
      ...(makeV2().clips as any[])[0],
      layout_plan: { preferred_layout: 'weird_layout', expected_speakers: null, allow_split: true, allow_blur_background: true },
    }];
    expect(() => RenderRequestV2Schema.parse(makeV2({ clips }))).toThrow();
  });

  it('rejects editing event outside clip range', () => {
    const clips = [{
      ...(makeV2().clips as any[])[0],
      editing_events: [{ time_sec: 9.0, type: 'punchline', intensity: 0.5 }],
    }];
    expect(() => RenderRequestV2Schema.parse(makeV2({ clips }))).toThrow();
  });

  it('rejects empty clips array', () => {
    expect(() => RenderRequestV2Schema.parse(makeV2({ clips: [] }))).toThrow();
  });
});
