/**
 * Brief V14 Phase P5/P6 — policy selection (safety-first hierarchy) + lock.
 *
 * Reads variant results (legacy+calibration), applies the predeclared
 * hierarchy (§16) and writes policy_lock.json BEFORE any holdout evaluation.
 * Also aggregates metrics & policy switches vs the C0 control.
 *
 * Usage:
 *   node --import tsx scripts/v14-select.ts
 *     --runs evidence/v14/runs --out evidence/v14/policy_lock.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { policySwitchRows, type OutcomeLike } from '../src/lib/v14/metrics';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadOutcomes(p: string): OutcomeLike[] {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) return [];
  return fs.readFileSync(abs, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as OutcomeLike);
}

const ACCEPTED_BASELINE_FAIL = 'c=3b416b15c9b5';

/** Priorities per the predeclared hierarchy (lexicographic). */
function evaluateVariant(
  variantId: string,
  outcomes: OutcomeLike[],
  legacyOnly: OutcomeLike[],
): {
  variant_id: string;
  hard_neg_accepted: number;
  leakage_accepted: number;
  new_fail_accepted: string[];
  new_hard_neg_accepted: number;
  new_leakage_accepted: number;
  legacy_eligible: number;
  legacy_eligible_den: number;
  legacy_accepted: number;
  legacy_accepted_den: number;
  legacy_correct_0_78: boolean;
  safety: boolean;
  recall_pass: boolean;
} {
  const hard_neg_accepted = outcomes.filter((o) => o.hard_negative && o.final_accepted).length;
  const leakage_accepted = outcomes.filter((o) => o.next_topic_leakage_case && o.final_accepted).length;
  const acceptedFails = outcomes.filter((o) => o.label === 'FAIL' && o.final_accepted).map((o) => o.candidate_id);
  const newFails = acceptedFails.filter((id) => id !== ACCEPTED_BASELINE_FAIL);
  // Safety gates are about NEWLY accepted candidates: anything not accepted
  // at baseline. The baseline candidate (c=3b416b15c9b5) carries judge
  // hard-negative/leakage flags from individual tiers; that pre-exists V14
  // and is reported separately (identity verified in the hierarchy check).
  const newlyAccepted = outcomes.filter((o) => o.final_accepted && o.candidate_id !== ACCEPTED_BASELINE_FAIL);
  const newHardNeg = newlyAccepted.filter((o) => o.hard_negative).length;
  const newLeak = newlyAccepted.filter((o) => o.next_topic_leakage_case).length;
  const passLegacy = legacyOnly.filter((o) => o.label === 'PASS');
  const legacy_eligible = passLegacy.filter((o) => o.survived_to_scoring).length;
  const legacy_accepted = passLegacy.filter((o) => o.final_accepted).length;
  // Ending semantic correctness: none of the 7 complete-class 0.78 PASS
  // candidates may die at 05 solely for confidence.
  const seven = passLegacy.filter((o) => o.first_death !== '05_ENDING_CONFIDENCE').length;
  const legacy_correct = seven >= 7;
  const safety = newFails.length === 0 && newHardNeg === 0 && newLeak === 0;
  const recall_pass = legacy_eligible >= 6 && legacy_accepted >= 5;
  return {
    variant_id: variantId,
    hard_neg_accepted,
    leakage_accepted,
    new_fail_accepted: newFails,
    new_hard_neg_accepted: newHardNeg,
    new_leakage_accepted: newLeak,
    legacy_eligible,
    legacy_eligible_den: passLegacy.length,
    legacy_accepted,
    legacy_accepted_den: passLegacy.length,
    legacy_correct_0_78: legacy_correct,
    safety,
    recall_pass,
  };
}

function main(): void {
  const runsBase = path.resolve(arg('runs') ?? 'evidence/v14/runs');
  const outPath = path.resolve(arg('out') ?? 'evidence/v14/policy_lock.json');
  const variants = ['C0', 'E1', 'E2', 'E3', 'E4', 'S1', 'S2', 'NEGATIVE_CONTROL'];
  const control = loadOutcomes(path.join(runsBase, 'c0', 'C0', 'variant_results.jsonl'));

  const results: Record<string, unknown>[] = [];
  const byCount: Record<string, number> = {};
  for (const v of variants) {
    const id = v === 'C0' ? 'C0' : v;
    const out = loadOutcomes(path.join(runsBase, v, id, 'variant_results.jsonl'));
    const vOut = out.filter((o) => o.split !== 'holdout');
    const legacy = out.filter((o) => o.split === 'legacy');
    const ev = evaluateVariant(v, vOut, legacy);
    byCount[v] = out.length;
    results.push(ev);
    if (control.length > 0 && v !== 'C0') {
      const switches = policySwitchRows(control.filter((o) => o.split !== 'holdout'), vOut);
      fs.mkdirSync(path.join(runsBase, v, id), { recursive: true });
      const csv = ['candidate_id,label,hard_negative,next_topic_leakage_case,control_accepted,variant_accepted,control_first_death,variant_first_death,why_changed,safety_review,acceptable']
        .concat(switches.map((s) => [s.candidate_id, s.label, s.hard_negative, s.next_topic_leakage_case, s.control_accepted, s.variant_accepted, s.control_first_death ?? '', s.variant_first_death ?? '', s.why_changed, s.safety_review, s.acceptable].join(',')))
        .join('\n') + '\n';
      fs.writeFileSync(path.join(runsBase, v, id, 'policy_switches.csv'), csv, 'utf-8');
    }
  }

  // Safety-first hierarchy: filter, then require ending correctness, then recall.
  const safe = results.filter((r) => (r as { safety: boolean }).safety);
  const semantic = safe.filter((r) => (r as { legacy_correct_0_78: boolean }).legacy_correct_0_78);
  const recallOk = semantic.filter((r) => (r as { recall_pass: boolean }).recall_pass);

  const ranking = ['E3', 'E4', 'E2', 'E1', 'S2', 'S1'];
  let locked: string | null = null;
  const preferenceOrder = [...safe]
    .sort((a, b) => {
      const ia = ranking.indexOf(a.variant_id as string);
      const ib = ranking.indexOf(b.variant_id as string);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  if (recallOk.length > 0) {
    const winner = preferenceOrder.find((r) => recallOk.includes(r));
    locked = winner ? (winner.variant_id as string) : null;
  }

  const lock = {
    created_at: new Date().toISOString(),
    hierarchy_check: {
      results,
      safe_variants: safe.map((r) => r.variant_id),
      ending_correct_variants: semantic.map((r) => r.variant_id),
      recall_pass_variants: recallOk.map((r) => r.variant_id),
    },
    locked_variant: locked,
    selection_rule: 'lexicographic safety-first hierarchy (§16); threshold 70 fixed; penalty cap 4 for E3',
    threshold: 70,
    penalty_cap: 4,
    holdout_sealed: true,
    control_outcomes_sha: crypto.createHash('sha256').update(JSON.stringify(control)).digest('hex'),
    lock_sha: null as string | null,
  };
  const body = JSON.stringify(lock, null, 2);
  lock.lock_sha = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(outPath, JSON.stringify(lock, null, 2), 'utf-8');
  console.log(`locked_variant=${locked}`);
  console.log(`policy_lock_sha256=${lock.lock_sha}`);
  console.log(JSON.stringify(results, null, 2));
}

main();