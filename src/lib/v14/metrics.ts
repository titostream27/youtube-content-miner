/**
 * Brief V14 — metric accounting (§15) with exact denominators and 95%
 * Wilson intervals (§17). Pure functions; no I/O.
 */

export interface MetricRow {
  metric_name: string;
  split: string;
  episode_id: string | null;
  numerator: number;
  denominator: number;
  rate: number | null;
  ci95_low: number | null;
  ci95_high: number | null;
  target_operator: string | null;
  target_value: number | null;
  pass: boolean | null;
  notes: string;
}

/** Wilson 95% interval for a binomial rate. */
export function wilson95(n: number, N: number): { low: number; high: number } {
  if (N <= 0) return { low: NaN, high: NaN };
  const z = 1.959963984540054;
  const p = n / N;
  const denom = 1 + (z * z) / N;
  const centre = (p + (z * z) / (2 * N)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / N + (z * z) / (4 * N * N))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export type Label = 'PASS' | 'FAIL' | 'REVIEW';

export interface OutcomeLike {
  candidate_id: string;
  episode_id: string;
  label: Label;
  split: string;
  hard_negative: boolean;
  next_topic_leakage_case: boolean;
  survived_to_scoring: boolean;
  final_accepted: boolean;
  final_score: number | null;
  first_death: string | null;
  variant_id: string;
}

type Filter = (r: OutcomeLike) => boolean;

export function computeRates(rows: OutcomeLike[], split: string): MetricRow[] {
  const out: MetricRow[] = [];
  const pool = rows.filter((r) => r.split === split);
  const run = (
    name: string,
    denom: Filter,
    num: Filter,
    targetOp: string | null,
    targetVal: number | null,
    episode: string | null = null,
  ): void => {
    const base = episode === null ? pool : pool.filter((r) => r.episode_id === episode);
    const N = base.filter(denom).length;
    const n = base.filter((r) => denom(r) && num(r)).length;
    const rate = N > 0 ? n / N : null;
    const ci = N > 0 ? wilson95(n, N) : { low: NaN, high: NaN };
    const pass = targetVal !== null && rate !== null
      ? targetOp === '>=' ? rate >= targetVal : targetOp === '<=' ? rate <= targetVal : rate === targetVal
      : null;
    out.push({
      metric_name: name,
      split,
      episode_id: episode,
      numerator: n,
      denominator: N,
      rate: rate === null ? null : Number(rate.toFixed(4)),
      ci95_low: Number.isFinite(ci.low) ? Number(ci.low.toFixed(4)) : null,
      ci95_high: Number.isFinite(ci.high) ? Number(ci.high.toFixed(4)) : null,
      target_operator: targetOp,
      target_value: targetVal,
      pass,
      notes: N === 0 ? 'denominator zero' : '',
    });
  };

  const passDen = (r: OutcomeLike): boolean => r.label === 'PASS';
  const failDen = (r: OutcomeLike): boolean => r.label === 'FAIL';

  run('PASS_Recall@Eligible', passDen, (r) => r.survived_to_scoring, '>=', 0.75);
  run('PASS_Recall@Accepted', passDen, (r) => r.final_accepted, '>=', 0.5);
  run('Silver-FAIL Leakage@Accepted', failDen, (r) => r.final_accepted, '<=', 0.0);
  run('Hard-Negative Acceptance', (r) => r.hard_negative, (r) => r.final_accepted, '<=', 0.0);
  run('Next-Topic Leakage Acceptance', (r) => r.next_topic_leakage_case, (r) => r.final_accepted, '<=', 0.0);

  for (const ep of Array.from(new Set(pool.map((r) => r.episode_id))).sort()) {
    run('PASS_Recall@Eligible', passDen, (r) => r.survived_to_scoring, null, null, ep);
    run('PASS_Recall@Accepted', passDen, (r) => r.final_accepted, null, null, ep);
  }
  return out;
}

export interface PolicySwitchRow {
  candidate_id: string;
  label: Label;
  hard_negative: boolean;
  next_topic_leakage_case: boolean;
  control_accepted: boolean;
  variant_accepted: boolean;
  control_first_death: string | null;
  variant_first_death: string | null;
  why_changed: string;
  safety_review: string;
  acceptable: boolean;
}

/** Candidates whose outcome differs from control (paired candidate-level). */
export function policySwitchRows(control: OutcomeLike[], variant: OutcomeLike[]): PolicySwitchRow[] {
  const byId = new Map(variant.map((r) => [r.candidate_id, r]));
  const out: PolicySwitchRow[] = [];
  for (const c of control) {
    const v = byId.get(c.candidate_id);
    if (!v) continue;
    if (v.final_accepted === c.final_accepted && v.first_death === c.first_death) continue;
    const becameAccepted = v.final_accepted && !c.final_accepted;
    const flag = v.hard_negative || v.next_topic_leakage_case;
    const safety = flag ? (v.label === 'FAIL' ? 'NEW_SILVER_FAIL_OR_FLAGGED' : 'FLAGGED_SAFETY_CLASS') : 'CLEAN';
    out.push({
      candidate_id: c.candidate_id,
      label: v.label,
      hard_negative: v.hard_negative,
      next_topic_leakage_case: v.next_topic_leakage_case,
      control_accepted: c.final_accepted,
      variant_accepted: v.final_accepted,
      control_first_death: c.first_death,
      variant_first_death: v.first_death,
      why_changed: becameAccepted ? 'newly accepted' : 'no longer accepted / first-death moved',
      safety_review: safety,
      acceptable: becameAccepted ? safety === 'CLEAN' : true,
    });
  }
  return out;
}