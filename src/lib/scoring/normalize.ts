/** Shared numeric helpers used by both scoring models. */

export function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Map a value onto 0-100 using a piecewise linear curve.
 *
 * `points` must be sorted ascending by input. Values outside the range clamp
 * to the nearest endpoint. This keeps every heuristic explicit and auditable
 * instead of hiding behind a magic formula.
 */
export function piecewise(value: number, points: readonly [number, number][]): number {
  if (points.length === 0) return 0;

  const first = points[0]!;
  if (value <= first[0]) return first[1];

  const last = points[points.length - 1]!;
  if (value >= last[0]) return last[1];

  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    if (value >= x0 && value <= x1) {
      if (x1 === x0) return y1;
      const ratio = (value - x0) / (x1 - x0);
      return y0 + ratio * (y1 - y0);
    }
  }

  return last[1];
}

/**
 * Log-scale a count onto 0-100. Useful for metrics with heavy tails such as
 * views and subscribers where the difference between 1k and 10k matters far
 * more than the difference between 1M and 1.01M.
 */
export function logScale(value: number, midpoint: number, ceiling: number): number {
  const safeValue = Math.max(0, value);
  if (safeValue <= 0) return 0;

  const logValue = Math.log10(safeValue + 1);
  const logMid = Math.log10(Math.max(1, midpoint) + 1);
  const logCeiling = Math.log10(Math.max(midpoint + 1, ceiling) + 1);

  if (logValue <= logMid) {
    return clamp((logValue / logMid) * 60);
  }
  const ratio = (logValue - logMid) / (logCeiling - logMid);
  return clamp(60 + ratio * 40);
}

/**
 * Bell curve around an ideal value. Returns 100 at `ideal` and decays towards
 * 0 as the value moves `tolerance` away in either direction.
 */
export function bell(value: number, ideal: number, tolerance: number): number {
  if (tolerance <= 0) return value === ideal ? 100 : 0;
  const distance = Math.abs(value - ideal) / tolerance;
  return clamp(100 * Math.exp(-0.5 * distance * distance));
}

export function weightedAverage<K extends string>(
  scores: Record<K, number>,
  weights: Record<K, number>,
): number {
  let total = 0;
  let weightSum = 0;
  for (const key of Object.keys(weights) as K[]) {
    const weight = weights[key];
    total += clamp(scores[key]) * weight;
    weightSum += weight;
  }
  return weightSum === 0 ? 0 : total / weightSum;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = mean(values.map((value) => (value - average) ** 2));
  return Math.sqrt(variance);
}

export function daysSince(isoDate: string, now = new Date()): number {
  const published = new Date(isoDate).getTime();
  if (!Number.isFinite(published)) return 3650;
  const diffMs = now.getTime() - published;
  return Math.max(0, diffMs / 86_400_000);
}
