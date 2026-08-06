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
  /**
   * Hardening v3 F3: dataset matrix metadata so coverage is explicit and
   * measurable against the brief (EN/ID, clean/noisy captions).
   */
  language?: 'en' | 'id';
  /** Caption source quality: clean (manual/YT captions) or noisy (ASR). */
  captionsQuality?: 'clean' | 'noisy';
}

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    id: 'growth-podcast',
    language: 'en',
    captionsQuality: 'clean',
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
    language: 'en',
    captionsQuality: 'clean',
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
  {
    // Hardening sprint Phase E: third fixture — BILINGUAL (Indonesian/English)
    // with an overlapping reaction window and a hard-negative (sponsor segment
    // that must NOT be a positive moment) to exercise start-complete and
    // contamination classification.
    id: 'podcast-bilingual-reaction',
    language: 'id',
    captionsQuality: 'clean',
    transcriptCues: [
      { startSec: 0, endSec: 5, text: 'Halo semua, selamat datang kembali di podcast.' },
      { startSec: 5, endSec: 9, text: 'Today we have a very special guest joining us.' },
      { startSec: 9, endSec: 14, text: 'Sebelum kita mulai, dulu sponsor kita dulu ya.' },
      { startSec: 14, endSec: 19, text: 'Use code GROWTH for twenty percent off your first order.' },
      { startSec: 19, endSec: 25, text: 'Okay let us actually start the real conversation.' },
      { startSec: 25, endSec: 30, text: 'Jadi gimana perasaan lo setelah perjalanan panjang itu?' },
      { startSec: 30, endSec: 37, text: 'Honestly, I felt like giving up in the first two years.' },
      { startSec: 37, endSec: 44, text: 'Ada satu momen di mana semua terasa sia-sia banget.' },
      { startSec: 44, endSec: 52, text: 'But then one message from one user changed everything.' },
      { startSec: 52, endSec: 58, text: 'Itu pesan kecil tapi mikir banget buat gue.' },
      { startSec: 58, endSec: 65, text: 'So the real lesson is to keep going through the doubt.' },
      { startSec: 65, endSec: 70, text: 'Oke, terakhir, pesan apa buat orang yang baru mulai?' },
    ],
    labels: [
      {
        clipId: 'b1',
        expectedScore: 92,
        expectedStartSec: 30,
        expectedEndSec: 44,
        expectedContamination: 0.02,
        expectedStartComplete: true,
        expectedEndingComplete: true,
      },
      {
        // Hard negative: the sponsor block must NOT score anywhere near the
        // editorial moments.
        clipId: 'b2',
        expectedScore: 60,
        expectedStartSec: 9,
        expectedEndSec: 25,
        expectedContamination: 0.12,
        expectedStartComplete: false,
        expectedEndingComplete: false,
      },
      {
        clipId: 'b3',
        expectedScore: 84,
        expectedStartSec: 44,
        expectedEndSec: 58,
        expectedContamination: 0.04,
        expectedStartComplete: true,
        expectedEndingComplete: true,
      },
    ],
    // Bilingual hard-negative exercises start-boundary (a reaction window may
    // open mid-thought); top-1 should resolve the editorial moment, not the
    // sponsor block.
    topK: 1,
  },
  {
    // Hardening v3 F3 (#33): single hard-negative — a clean clip whose
    // sponsor/CTA sentence is pure contamination. Exercises the
    // contamination metric and tests that a filtered prediction reports
    // non-zero contamination when it wrongly includes the sponsor.
    id: 'golden-contamination',
    language: 'en',
    captionsQuality: 'noisy',
    transcriptCues: [
      { startSec: 0, endSec: 18, text: 'We launched the second protocol in April. Use code AFLAB for ten percent off your annual plan.' },
      { startSec: 18, endSec: 88, text: 'The retention numbers shocked everyone. It changed how we ship software.' },
    ],
    labels: [
      {
        clipId: 'c1',
        expectedScore: 92,
        expectedStartSec: 0,
        expectedEndSec: 18,
        expectedContamination: 0.35, // includes the sponsor sentence
        expectedStartComplete: true,
        expectedEndingComplete: false,
      },
      {
        clipId: 'c2',
        expectedScore: 88,
        expectedStartSec: 58,
        expectedEndSec: 88,
        expectedContamination: 0.0, // clean editorial
        expectedStartComplete: true,
        expectedEndingComplete: true,
      },
    ],
    topK: 2,
  },
  {
    // Hardening v3 F3 coverage: Indonesian, NOISY ASR captions. Exercises
    // diarization-less ASR with misheard words ("kanguru" vs "program").
    id: 'podcast-id-noisy-asr',
    language: 'id',
    captionsQuality: 'noisy',
    transcriptCues: [
      { startSec: 0, endSec: 6, text: 'hai semuanya kita balik lagi di episode baru' },
      { startSec: 6, endSec: 12, text: 'tadi gue ngomong sama kanguru yang bikin gue merinding' },
      { startSec: 12, endSec: 19, text: 'bahasa dalam tim itu selalu pin, bukan, selalu WIN' },
      { startSec: 19, endSec: 25, text: 'jadii gimana tuh perpisahan di bulan pertama' },
      { startSec: 25, endSec: 32, text: 'semua orang di meja itu mah psicker dan kita bisa nebakinya' },
      { startSec: 32, endSec: 39, text: 'di bulan ketiga gue lihat angkanya, gue kaget alias tak tak tak' },
      { startSec: 39, endSec: 46, text: 'jadi pesan gue jangan takut gagal di awal' },
    ],
    labels: [
      { clipId: 'n1', expectedScore: 88, expectedStartSec: 32, expectedEndSec: 46, expectedContamination: 0.08, expectedStartComplete: true, expectedEndingComplete: true },
      { clipId: 'n2', expectedScore: 72, expectedStartSec: 0, expectedEndSec: 12, expectedContamination: 0.6, expectedStartComplete: false, expectedEndingComplete: false },
    ],
    topK: 1,
  },
  {
    // Hardening v3 F3 coverage: multi-speaker EN with noisy ASR and an
    // explicit hard-negative (weak hook = negative).
    id: 'podcast-multispeaker-noisy',
    language: 'en',
    captionsQuality: 'noisy',
    transcriptCues: [
      { startSec: 0, endSec: 5, text: 'so we found the growth lever through the roof' },
      { startSec: 5, endSec: 10, text: 'guest the paid channel doubled in ninety days' },
      { startSec: 10, endSec: 16, text: 'host that is crazy tell me about the dashboard' },
      { startSec: 16, endSec: 23, text: 'guest we just looked at cohorts and the numbers popped' },
      { startSec: 23, endSec: 30, text: 'host and the budget stayed flat right' },
      { startSec: 30, endSec: 36, text: 'so like the thing is you know we do the thing' },
    ],
    labels: [
      // Positive: dialog moment, complete on both sides.
      { clipId: 'm1', expectedScore: 90, expectedStartSec: 5, expectedEndSec: 23, expectedContamination: 0.02, expectedStartComplete: true, expectedEndingComplete: true },
      // Hard negative: ambiguous filler with no resolved thought.
      { clipId: 'm2', expectedScore: 40, expectedStartSec: 30, expectedEndSec: 36, expectedContamination: 0.9, expectedStartComplete: false, expectedEndingComplete: false },
    ],
    topK: 1,
  },
];
