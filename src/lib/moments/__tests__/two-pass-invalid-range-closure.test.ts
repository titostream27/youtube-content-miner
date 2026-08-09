import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MomentSegment, Transcript } from '@/lib/domain/types';

const refineBoundaries = vi.fn();

vi.mock('@/lib/ai/agents/boundary-refinement-agent', () => ({
  refineBoundaries,
}));

function roughSegment(): MomentSegment {
  return {
    index: 0,
    startSec: 10,
    endSec: 50,
    durationSec: 40,
    text: 'A complete rough candidate with enough context to be valid.',
    wordCount: 10,
    wordsPerSecond: 0.25,
    salience: 0.8,
    candidateId: 'rough-0',
    generationRunId: 'test-run',
    revision: 1,
  };
}

function transcript(): Transcript {
  return {
    videoId: 'invalid-semantic-range',
    source: 'youtube_asr',
    language: 'en',
    durationSec: 60,
    wordCount: 35,
    cues: [
      { startSec: 0, endSec: 10, text: 'Previous context ends cleanly.' },
      { startSec: 10, endSec: 20, text: 'The candidate starts with a complete setup.' },
      { startSec: 20, endSec: 30, text: 'It develops the idea with useful context.' },
      { startSec: 30, endSec: 40, text: 'The explanation reaches its main point.' },
      { startSec: 40, endSec: 50, text: 'The complete conclusion ends here.' },
      { startSec: 50, endSec: 60, text: 'What is the next topic?' },
    ],
  };
}

describe('two-pass closure fail-closed range validation', () => {
  beforeEach(() => {
    refineBoundaries.mockReset();
  });

  it('rejects semantic end-before-start without clamping or repair fallback', async () => {
    refineBoundaries.mockResolvedValue({
      aiGenerated: true,
      warnings: [],
      items: [
        {
          index: 0,
          finalStartSec: 45,
          finalEndSec: 35,
          endingType: 'CONCLUSION',
          endingComplete: true,
          endingConfidence: 0.95,
          nextTopicDetected: false,
          nextTopicStart: null,
          nextTopicContamination: 0,
          reason: 'invalid model range fixture',
        },
      ],
    });

    const { twoPassHighlightSelection } = await import('@/lib/moments/two-pass');
    const result = await twoPassHighlightSelection(
      transcript(),
      [roughSegment()],
      'Invalid range fixture',
      { minDurationSec: 14, maxDurationSec: 60, targetDurationSec: 38, maxSegments: 1 },
    );

    expect(result.segments).toEqual([]);
    expect(result.warnings).toContain('highlight 0: rejected invalid semantic range (45.00-35.00)');
  });
});
