/**
 * Brief V12R — Emit evidence/v12r/benchmark_manifest.json consolidating the
 * benchmark configuration + run metadata (judge tiers, floor, sample seed,
 * funnel strat counts, run timestamp, provider list).
 * Usage: node --import tsx scripts/v12r-benchmark-manifest.ts
 */
import fs from 'node:fs';

function main(): void {
  const sample = JSON.parse(fs.readFileSync('evidence/v12r/sample_manifest.json', 'utf-8')) as { sample: { stratum: string }[]; seed: number; source_pool_size: number };
  const metrics = fs.existsSync('evidence/v12r/benchmark_metrics.json')
    ? (JSON.parse(fs.readFileSync('evidence/v12r/benchmark_metrics.json', 'utf-8')) as Record<string, unknown>)
    : null;

  const strat = sample.sample.reduce<Record<string, number>>((acc, e) => {
    acc[e.stratum] = (acc[e.stratum] ?? 0) + 1;
    return acc;
  }, {});

  const manifest = {
    brief: 'Brief_V12R_Automated_Quality_Judge_Recovery.pdf',
    generated_at: new Date().toISOString(),
    judge_independence_tier: 'Good+ (three model families, two provider endpoints)',
    judges: {
      A: { provider: 'deepseek', endpoint: '9router 127.0.0.1:20128/v1', model: 'ds/deepseek-v4-flash', family: 'DeepSeek' },
      B: { provider: 'openrouter', endpoint: 'api.openrouter.ai', model: 'google/gemini-2.5-flash-lite', family: 'Google' },
      C: { provider: 'openai(channel=9router)', endpoint: '9router 127.0.0.1:20128/v1', model: 'cx/gpt-5.6-luna', family: 'OpenAI GPT' },
    },
    confidence_floor: process.env.V12R_JUDGE_CONFIDENCE_FLOOR ?? '0.5 (default)',
    sampling: { seed: sample.seed, target: 72, sample_count: sample.sample.length, source_pool: sample.source_pool_size, strat_counts: strat },
    metrics,
    evidence_files: [
      'evidence/v12r/sample_manifest.json',
      'evidence/v12r/judge_outputs.jsonl',
      'evidence/v12r/consensus_labels.jsonl',
      'evidence/v12r/h6_counterfactual.jsonl',
      'evidence/v12r/h1_counterfactual.jsonl',
      'evidence/v12r/combined_counterfactual.jsonl',
      'evidence/v12r/production_g2.jsonl',
    ],
  };

  fs.writeFileSync('evidence/v12r/benchmark_manifest.json', JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`wrote evidence/v12r/benchmark_manifest.json (${manifest.sampling.sample_count} candidates)`);
}

main();