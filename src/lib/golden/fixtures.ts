import type { GoldenLabel } from '@/lib/golden/metrics';

/**
 * Phase 2 (Golden dataset) — Labeled intelligence fixtures.
 *
 * Each fixture is a real, self-contained transcript fragment with a HAND
 * LABEL for the expected clip boundaries / scores / contamination. The
 * golden test runs the deterministic pipeline (no LLM) and compares with
 * `evaluateGolden` — so regressions in boundary detection, ranking and
 * contamination appear as measurable metric drift.
 *
 * Metrics measured: top-k recall (plain + rank-aware), mean boundary start/
 * end error (sec), mean contamination error, start/end completeness accuracy.
 */

export interface GoldenFixture {
  id: string;
  transcriptCues: { startSec: number; endSec: number; text: string }[];
  labels: GoldenLabel[];
  topK: number;
}

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    id: 'growth-podcast',
    transcriptCues: [
      { startSec: 0, endSec: 3, text: 'Welcome back to the show everyone.' },
      { startSec: 3, endSec: 6, text: 'Today we are talking about startup growth.' },
      { startSec: 6, endSec: 10, text: 'Our guest scaled a company to a hundred employees.' },
      { startSec: 10, endSec: 14, text: 'Most founders make the same mistake with hiring.' },
      { startSec: 14, endSec: 19, text: 'They hire for skill instead of culture fit.' },
      { startSec: 19, endSec: 24, text: 'And that single mistake killed three companies I know.' },
      { startSec: 24, endSec: 28, text: 'So what is the fix for this pattern?' },
      { startSec: 28, endSec: 34, text: 'You interview for values before you interview for skills.' },
      { startSec: 34, endSec: 38, text: 'That sounds simple but almost nobody does it.' },
      { startSec: 38, endSec: 42, text: 'We saw a forty percent drop in churn after one quarter.' },
      { startSec: 42, endSec: 46, text: 'Now let me ask about your fundraising journey.' },
      { startSec: 46, endSec: 50, text: 'We raised a seed round during the pandemic.' },
    ],
    labels: [
      {
        clipId: 'g1',
        expectedScore: 92,
        expectedStartSec: 19,
        expectedEndSec: 28,
        expectedContamination: 0.05,
        expectedStartComplete: true,
        expectedEndingComplete: true,
      },
      {
        clipId: 'g2',
        expectedScore: 88,
        expectedStartSec: 28,
        expectedEndSec: 42,
        expectedContamination: 0.02,
        expectedStartComplete: true,
        expectedEndingComplete: true,
      },
      {
        clipId: 'g3',
        expectedScore: 70,
        expectedStartSec: 10,
        expectedEndSec: 19,
        expectedContamination: 0.08,
        expectedStartComplete: true,
        expectedEndingComplete: true,
      },
    ],
    topK: 2,
  },
  {
    // Phase-2 F22: second fixture — overlapping candidate windows exercise
    // temporal-IoU matching (prediction ids may differ from label ids).
    id: 'podcast-guest-story',
    transcriptCues: [
      { startSec: 0, endSec: 4, text: 'So you started in a garage in 2015.' },
      { startSec: 4, endSec: 9, text: 'Yeah and we had no idea what we were doing.' },
      { startSec: 9, endSec: 15, text: 'The first product launch was a total disaster.' },
      { startSec: 15, endSec: 21, text: 'We shipped a broken build to ten thousand customers.' },
      { startSec: 21, endSec: 27, text: 'People were furious and we almost shut down.' },
      { startSec: 27, endSec: 33, text: 'But the emails from customers taught us everything.' },
      { startSec: 33, endSec: 40, text: 'We rewrote the entire product in three weeks.' },
      { startSec: 40, endSec: 46, text: 'That rewrite is why the company still exists today.' },
      { startSec: 46, endSec: 52, text: 'So the lesson is ship fast but listen faster.' },
      { startSec: 52, endSec: 58, text: 'Now switching to how you priced the second version.' },
    ],
    labels: [
      {
        clipId: 'p1',
        expectedScore: 90,
        expectedStartSec: 15,
        expectedEndSec: 27,
        expectedContamination: 0.03,
        expectedStartComplete: true,
        expectedEndingComplete: true,
      },
      {
        clipId: 'p2',
        expectedScore: 84,
        expectedStartSec: 33,
        expectedEndSec: 46,
        expectedContamination: 0.02,
        expectedStartComplete: true,
        expectedEndingComplete: true,
      },
      {
        clipId: 'p3',
        expectedScore: 75,
        expectedStartSec: 21,
        expectedEndSec: 33,
        expectedContamination: 0.06,
        expectedStartComplete: true,
        expectedEndingComplete: true,
      },
    ],
    topK: 2,
  },
];
