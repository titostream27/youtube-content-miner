import { describe, it, expect } from 'vitest';
import { computeMarketFit } from '@/lib/market/market-fit';
import { mineComments } from '@/lib/analytics/comment-mining';

describe('computeMarketFit (brief §29)', () => {
  it('recommends US for English USD content', () => {
    const r = computeMarketFit({
      hook: 'NASA is launching a $5 billion rocket program',
      transcript: 'The United States Congress approved the budget with a vote.',
    });
    expect(r.recommendedMarket).toBe('US');
    expect(r.marketFit.US).toBeGreaterThan(r.marketFit.AU);
    expect(r.reasons).toContain('USD examples');
  });

  it('recommends AU for AUD + footpath vocabulary', () => {
    const r = computeMarketFit({
      hook: 'AUD $200 million footpath project in Sydney',
      transcript: 'We went on holiday and took the lift instead of the stairs.',
    });
    expect(r.recommendedMarket).toBe('AU');
  });

  it('separates CH languages — German content goes to CH-DE not CH-FR', () => {
    const r = computeMarketFit({
      hook: 'Das ist der neue Plan für die Schweiz',
      transcript: 'Wir haben die besten Ergebnisse und das ist nicht zu glauben.',
    });
    expect(r.marketFit.CH_DE).toBeGreaterThan(r.marketFit.CH_FR);
    expect(r.marketFit.CH_DE).toBeGreaterThan(r.marketFit.CH_IT);
  });

  it('CHF examples boost all Swiss markets', () => {
    const r = computeMarketFit({
      hook: 'Der Preis beträgt 50 CHF',
    });
    expect(r.marketFit.CH_DE).toBeGreaterThanOrEqual(60);
    // CH-FR/CH-IT get the CHF currency boost but no German language signal.
    expect(r.marketFit.CH_FR).toBe(28);
    expect(r.marketFit.CH_IT).toBe(28);
  });

  it('French content goes to CH-FR', () => {
    const r = computeMarketFit({
      hook: 'La Suisse est un beau pays avec les montagnes',
    });
    expect(r.marketFit.CH_FR).toBeGreaterThan(r.marketFit.CH_DE);
  });

  it('clamps scores to 0..100', () => {
    const r = computeMarketFit({
      hook: 'NASA US Congress $5 billion football sidewalk vacation',
      transcript: 'The United States of America with the IRS and White House and FBI.',
    });
    for (const v of Object.values(r.marketFit)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('mineComments (brief §31)', () => {
  const comments = [
    'Great episode! At 12:34 he explains it perfectly.',
    'The part at 1:02:03 was the best.',
    'How did he recover from bankruptcy?',
    'How did he recover from bankruptcy?',
    'He said "expansion multiplied a broken model" - wow',
    'He said "expansion multiplied a broken model" - crazy',
    'I disagree, this is misleading',
    'This is fake news!',
    'Please make part 2 about the market',
    'Please make part 2 about the market',
    'Cette video est superbe',
  ];

  it('extracts timestamp mentions in absolute seconds', () => {
    const r = mineComments('v1', comments);
    expect(r.timestampMentions.some((t) => t.timeSec === 12 * 60 + 34)).toBe(true);
    expect(r.timestampMentions.some((t) => t.timeSec === 3723)).toBe(true); // 1:02:03
  });

  it('detects repeated questions', () => {
    const r = mineComments('v1', comments);
    const q = r.repeatedQuestions.find((x) => x.text.toLowerCase().includes('recover from bankruptcy'));
    expect(q).toBeDefined();
    expect(q!.count).toBeGreaterThanOrEqual(2);
  });

  it('detects quoted statements and objections', () => {
    const r = mineComments('v1', comments);
    expect(r.quotedStatements.some((s) => s.text.includes('expansion'))).toBe(true);
    expect(r.objections).toBeGreaterThanOrEqual(1);
  });

  it('detects follow-up requests', () => {
    const r = mineComments('v1', comments);
    expect(r.followUpTopics.length).toBeGreaterThanOrEqual(1);
  });

  it('computes controversy score and language', () => {
    const r = mineComments('v1', comments);
    expect(r.controversyScore).toBeGreaterThan(0);
    expect(r.audienceLanguages.some((l) => l.lang === 'en')).toBe(true);
  });
});
