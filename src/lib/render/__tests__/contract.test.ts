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
    // renderJobId/renderError etc. above are typed as string|null already;
    // seoTitle requires string|null — pass null via the optional override.
    ...overrides,
  } as ClipRecord;
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
});
