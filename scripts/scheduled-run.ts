/**
 * Scheduled (cron) E2E entry point — multi-topic daily clip target loop.
 *
 * Pulls today's YouTube mostPopular videos, mines a popularity-ranked list of
 * topics worth mining, then walks that list one topic at a time:
 *
 *   for each ranked topic:
 *     runPipeline({ mode: 'topic', topic })      // discovery -> analysis -> clips
 *     autoProcessScheduled(runId)                // render -> SEO -> QC -> publish
 *     totalReady += readyCount
 *     stop once totalReady >= TRENDING_DAILY_CLIP_TARGET (default 15)
 *
 * The loop stops as soon as the running total of published (gate-clearing)
 * clips reaches the daily target, so the day's total can slightly exceed the
 * target — the last topic contributes all of its qualifying clips. Publishing
 * is fully automatic at each clip's assigned prime-time slot (no approval).
 *
 * Output: JSON summary printed to stdout (for Hermes cron `no_agent` mode)
 * and written to `data/scheduled-<firstRunId>.json`.
 *
 *   npm run scheduled -- --region ID --max 25 --target 15
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../src/lib/config';
import { listTrendingVideos } from '../src/lib/youtube/client';
import { planTrendingTopics } from '../src/lib/ai';
import { runPipeline } from '../src/lib/pipeline/orchestrator';
import { autoProcessScheduled } from '../src/lib/pipeline/scheduled-process';

interface CliArgs {
  region: string;
  maxVideos: number;
  target: number;
  maxTopics: number;
  force: boolean;
}

interface TopicOutcome {
  topic: string;
  runId: number | null;
  episodesAnalysed: number;
  clipsFound: number;
  readyCount: number;
  blockedCount: number;
  clipIds: number[];
  warnings: string[];
  error?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    region: config.trending.regionCode,
    maxVideos: config.trending.maxVideos,
    target: config.trending.dailyClipTarget,
    maxTopics: config.trending.maxLoopTopics,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case '--region':
        if (value) args.region = value;
        i += 1;
        break;
      case '--max':
        args.maxVideos = value ? Number.parseInt(value, 10) : args.maxVideos;
        i += 1;
        break;
      case '--target':
        args.target = value ? Number.parseInt(value, 10) : args.target;
        i += 1;
        break;
      case '--max-topics':
        args.maxTopics = value ? Number.parseInt(value, 10) : args.maxTopics;
        i += 1;
        break;
      case '--force':
        args.force = true;
        break;
      default:
        break;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `[scheduled-run] region=${args.region} maxVideos=${args.maxVideos} target=${args.target} maxTopics=${args.maxTopics}`,
  );

  // 1. Trending videos for the region.
  const videos = await listTrendingVideos({
    regionCode: args.region,
    maxResults: args.maxVideos,
  });
  console.log(`[scheduled-run] fetched ${videos.length} trending videos`);

  if (videos.length === 0) {
    console.log(JSON.stringify({ error: 'No trending videos returned', runId: null }));
    return;
  }

  // 2. Mine a popularity-ranked list of topics (ordered by mining priority).
  const mined = await planTrendingTopics({ videos, maxTopics: args.maxTopics });
  const rankedTopics = mined.plan.topics;
  console.log(
    `[scheduled-run] mined ${rankedTopics.length} topics (aiGenerated=${mined.aiGenerated}): ${rankedTopics.join(' | ')}`,
  );

  if (rankedTopics.length === 0) {
    console.log(JSON.stringify({ error: 'No topics mined from trending', runId: null }));
    return;
  }

  // 3. Walk the ranked topics until the daily clip target is met.
  // target <= 0 disables the cap: process every ranked topic, stopping only
  // when the mined topic list runs out (or maxLoopTopics was reached).
  const unlimitedTarget = args.target <= 0;
  const outcomes: TopicOutcome[] = [];
  let totalReady = 0;
  let firstRunId: number | null = null;
  let stoppedReason = unlimitedTarget
    ? 'no target set — processed all ranked topics'
    : 'exhausted topics before reaching target';

  for (let i = 0; i < rankedTopics.length; i += 1) {
    const topic = rankedTopics[i];
    if (!topic) continue;
    console.log(
      `[scheduled-run] topic ${i + 1}/${rankedTopics.length}: "${topic}"` +
        (unlimitedTarget ? '' : ` (running total ${totalReady}/${args.target})`),
    );

    const outcome: TopicOutcome = {
      topic,
      runId: null,
      episodesAnalysed: 0,
      clipsFound: 0,
      readyCount: 0,
      blockedCount: 0,
      clipIds: [],
      warnings: [],
    };

    try {
      const result = await runPipeline({ mode: 'topic', topic, force: args.force });
      firstRunId ??= result.runId;
      outcome.runId = result.runId;
      outcome.episodesAnalysed = result.episodesAnalysed;
      outcome.clipsFound = result.clipsFound;
      outcome.warnings = result.warnings;
      console.log(
        `[scheduled-run] topic "${topic}" run #${result.runId}: ${result.episodesAnalysed} analysed, ${result.clipsFound} clips`,
      );

      const sched = await autoProcessScheduled(result.runId);
      outcome.readyCount = sched.readyCount;
      outcome.blockedCount = sched.blockedCount;
      outcome.clipIds = sched.clipIds;
      totalReady += sched.readyCount;
      console.log(
        `[scheduled-run] topic "${topic}": ${sched.readyCount} published, ${sched.blockedCount} blocked (total ${totalReady}/${args.target})`,
      );
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : 'unknown pipeline error';
      console.error(`[scheduled-run] topic "${topic}" failed: ${outcome.error}`);
    }

    outcomes.push(outcome);

    // Only stop on the target when one is set (target > 0). Unlimited mode
    // (target <= 0) walks the whole ranked topic list.
    if (!unlimitedTarget && totalReady >= args.target) {
      stoppedReason = `reached daily target (${totalReady} >= ${args.target})`;
      console.log(`[scheduled-run] ${stoppedReason} — stopping after ${i + 1} topic(s)`);
      break;
    }
  }

  const targetMet = unlimitedTarget ? outcomes.length > 0 : totalReady >= args.target;
  if (unlimitedTarget) {
    stoppedReason = `no target set — processed all ${rankedTopics.length} ranked topics`;
  }

  // 4. Persist + print summary.
  const allClipIds = outcomes.flatMap((o) => o.clipIds);
  const aiUsage = {
    calls: 0,
    // Per-topic AI usage is logged to the cost ledger inside runPipeline; the
    // aggregate here is left at the loop level (published-clip focus).
  };

  const summary = {
    firstRunId,
    dailyTarget: args.target,
    totalReady,
    targetMet,
    stoppedReason,
    topicsPlanned: rankedTopics.length,
    topicsProcessed: outcomes.length,
    aiGenerated: mined.aiGenerated,
    rationale: mined.plan.rationale,
    trendingVideos: videos.length,
    region: args.region,
    clipIds: allClipIds,
    perTopic: outcomes.map((o) => ({
      topic: o.topic,
      runId: o.runId,
      episodesAnalysed: o.episodesAnalysed,
      clipsFound: o.clipsFound,
      readyCount: o.readyCount,
      blockedCount: o.blockedCount,
      error: o.error ?? null,
    })),
    warnings: Array.from(new Set([...mined.warnings, ...outcomes.flatMap((o) => o.warnings)])),
    primeTime: {
      us: { tz: config.primeTime.us.timeZone, slot: `${config.primeTime.us.hour}:${String(config.primeTime.us.minute).padStart(2, '0')}` },
      au: { tz: config.primeTime.au.timeZone, slot: `${config.primeTime.au.hour}:${String(config.primeTime.au.minute).padStart(2, '0')}` },
      ch: { tz: config.primeTime.ch.timeZone, slot: `${config.primeTime.ch.hour}:${String(config.primeTime.ch.minute).padStart(2, '0')}` },
    },
  };
  void aiUsage;

  // Write the summary next to the database. In the container DATABASE_PATH
  // is /data/content-miner.db (a mounted volume); falling back to ./data for
  // host runs. Never use process.cwd()/data — /app is read-only in the image.
  const dbPath = process.env.DATABASE_PATH;
  const outDir = dbPath ? path.dirname(dbPath) : path.join(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `scheduled-${firstRunId ?? 'none'}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));

  console.log(`[scheduled-run] summary written to ${outFile}`);
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error('[scheduled-run] failed:', error);
  process.exit(1);
});
