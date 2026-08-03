/**
 * Phase 3 (Master Task Brief §29) — Market fit scoring.
 *
 * Compute market fit for:
 *   US, AU, CH-EN, CH-DE, CH-FR, CH-IT
 *
 * Switzerland is NOT treated as one language audience — CH-EN / CH-DE /
 * CH-FR / CH-IT are separate.
 *
 * Signals (deterministic, provider-free):
 *   - spoken language            (language detection on transcript/hook)
 *   - currency / units           ($ vs AUD$ vs CHF, feet vs meters)
 *   - regional terminology       (e.g. "sidewalk" US vs "footpath" AU)
 *   - cultural references        (brands, institutions, sports)
 *   - guest recognition          (name casing heuristic — best effort)
 *   - publishing timezone        (explicit from caller; default neutral)
 *
 * Output matches the brief example:
 *   { market_fit: { US: 92, AU: 84, ... }, recommended_market: "US",
 *     reasons: [...] }
 */

export type MarketCode = 'US' | 'AU' | 'CH_EN' | 'CH_DE' | 'CH_FR' | 'CH_IT';

export const MARKETS: MarketCode[] = ['US', 'AU', 'CH_EN', 'CH_DE', 'CH_FR', 'CH_IT'];

export interface MarketFitResult {
  marketFit: Record<MarketCode, number>;
  recommendedMarket: MarketCode;
  reasons: string[];
}

/** Language markers (weak detection on small text — first match wins). */
const LANG_MARKERS: { lang: string; de: string; fr: string; it: string; re: RegExp }[] = [
  // German strong markers.
  { lang: 'de', de: 'der,die,das,und,nicht,ich,ist,ein,mit,auf', fr: '', it: '', re: /\b(der|die|das|und|nicht|ich|ist|ein|mit|auf|wir|sie)\b/i },
  // French strong markers.
  { lang: 'fr', de: '', fr: 'le,la,les,est,je,ne,pas,avec,une', it: '', re: /\b(le|la|les|est|je|ne|pas|avec|une|nous)\b/i },
  // Italian strong markers.
  { lang: 'it', de: '', fr: '', it: 'il,lo,la,non,che,per,con,una', re: /\b(il|lo|non|che|per|con|una|sono|è)\b/i },
  // English markers.
  { lang: 'en', de: '', fr: '', it: '', re: /\b(the|and|is|are|of|to|with|you|we)\b/i },
];

function detectLanguage(text: string): string {
  if (!text) return 'unknown';
  const scores: Record<string, number> = {};
  for (const marker of LANG_MARKERS) {
    const words = marker.de || marker.fr || marker.it || '';
    const list = words.split(',').filter(Boolean);
    let score = 0;
    for (const w of list) {
      const re = new RegExp(`\\b${w}\\b`, 'i');
      if (re.test(text)) score += 1;
    }
    // English baseline from the "the/and/is..." marker.
    if (marker.lang === 'en' && marker.re.test(text)) score += 1;
    scores[marker.lang] = score;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : 'unknown';
}

const USD_RE = /(?<!AUD\s)\$\s?\d|\b\d+\s?(dollars|bucks)\b|\bUSD\b/i;
const AUD_RE = /AUD\s?\$|\$A|\b\d+\s?aussie\b/i;
const CHF_RE = /CHF|\b\d+\s?francs\b/i;

const FEET_RE = /\b\d+\s?(feet|ft|miles|yards)\b/i;
const METERS_RE = /\b\d+\s?(meters|metres|km|kilograms|kg|grams)\b/i;

/** Regional terminology pairs (US vs AU/GB + CH flavours). */
const REGIONAL_TERMS: { us: RegExp; au: RegExp; label: string }[] = [
  { us: /\b(sidewalk|elevator|apartment|truck|vacation|soccer|fries)\b/i, au: /\b(footpath|lift|flat|ute|holiday|football|chips)\b/i, label: 'regional vocabulary' },
];

/** Cultural references (weak heuristic: known US/CH institution names). */
const US_REFS = /\b(NASA|Congress|White House|FBI|CIA|Super Bowl|NFL|NBA|IRS|$)\b/i;
const CH_REFS = /\b(Swiss|Zurich|Geneva|Lausanne|Bern|SBB|UBS|Nestlé|Basel)\b/i;

function contains(text: string, re: RegExp): boolean {
  return re.test(text);
}

/**
 * Compute market fit from a clip's hook/transcript.
 *
 * @param opts.hook hook or title text (short)
 * @param opts.transcript longer transcript text (optional)
 * @param opts.guestName guest name if known (best-effort recognition)
 * @param opts.publishingTz IANA tz hint (e.g. "Europe/Zurich" or "America/New_York")
 */
export function computeMarketFit(opts: {
  hook?: string;
  transcript?: string;
  guestName?: string | null;
  publishingTz?: string | null;
}): MarketFitResult {
  const text = [opts.hook, opts.transcript].filter(Boolean).join(' \n ');
  const lang = detectLanguage(text);

  const scores: Record<MarketCode, number> = {
    US: 30,
    AU: 25,
    CH_EN: 20,
    CH_DE: 20,
    CH_FR: 20,
    CH_IT: 20,
  };
  const reasons: string[] = [];

  // Spoken language drives the primary market.
  if (lang === 'en') {
    scores.US += 35;
    scores.AU += 30;
    scores.CH_EN += 25;
    reasons.push('English content');
  } else if (lang === 'de') {
    scores.CH_DE += 45;
    scores.CH_EN += 10;
    reasons.push('German content — CH-DE market');
  } else if (lang === 'fr') {
    scores.CH_FR += 45;
    scores.CH_EN += 10;
    reasons.push('French content — CH-FR market');
  } else if (lang === 'it') {
    scores.CH_IT += 45;
    scores.CH_EN += 10;
    reasons.push('Italian content — CH-IT market');
  } else {
    reasons.push('Language undetected — neutral baseline');
  }

  // Currency + units.
  if (contains(text, USD_RE)) {
    scores.US += 12;
    reasons.push('USD examples');
  }
  if (contains(text, AUD_RE)) {
    scores.AU += 12;
    reasons.push('AUD examples');
  }
  if (contains(text, CHF_RE)) {
    scores.CH_DE += 8;
    scores.CH_FR += 8;
    scores.CH_IT += 8;
    reasons.push('CHF examples');
  }
  if (contains(text, FEET_RE)) {
    scores.US += 4;
    scores.AU += 4;
  }
  if (contains(text, METERS_RE)) {
    scores.CH_DE += 4;
    scores.CH_FR += 4;
    scores.CH_IT += 4;
  }

  // Regional vocabulary.
  for (const pair of REGIONAL_TERMS) {
    if (contains(text, pair.us)) {
      scores.US += 6;
      reasons.push('US regional vocabulary');
    }
    if (contains(text, pair.au)) {
      scores.AU += 6;
      reasons.push('AU regional vocabulary');
    }
  }

  // Cultural references.
  if (contains(text, US_REFS)) {
    scores.US += 10;
    reasons.push('US cultural references');
  }
  if (contains(text, CH_REFS)) {
    scores.CH_DE += 6;
    scores.CH_FR += 6;
    scores.CH_IT += 6;
    reasons.push('Swiss cultural references');
  }

  // Guest recognition (best effort: guest name present in text).
  if (opts.guestName && opts.guestName.trim().length > 0) {
    const g = opts.guestName.trim();
    if (text.toLowerCase().includes(g.toLowerCase())) {
      scores.US += 6;
      scores.AU += 3;
      reasons.push(`${g} mentioned`);
    }
  }

  // Publishing timezone hint.
  if (opts.publishingTz) {
    if (opts.publishingTz.includes('America')) {
      scores.US += 5;
      reasons.push('US publishing timezone');
    } else if (opts.publishingTz.includes('Europe/Zurich')) {
      scores.CH_DE += 3;
      scores.CH_FR += 3;
      scores.CH_IT += 3;
      reasons.push('Swiss publishing timezone');
    }
  }

  // Clamp to 0..100.
  for (const m of MARKETS) {
    scores[m] = Math.max(0, Math.min(100, scores[m]));
  }

  const recommendedMarket = MARKETS.sort((a, b) => scores[b] - scores[a])[0]!;
  return { marketFit: scores, recommendedMarket, reasons };
}
