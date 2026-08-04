/**
 * Pipeline CLI.
 *
 * Runs a full discovery + analysis pass outside the web app. This is the entry
 * point the PRD's "Continuous Discovery" milestone needs: point cron at it and
 * the dashboard fills itself every morning.
 *
 *   npm run pipeline -- --topic "artificial intelligence"
 *   npm run pipeline -- --mode tracked_channels
 *   npm run pipeline -- --mode archive --channel demo-chan-signal
 *   npm run pipeline -- --mode trending   # picks today's mostPopular topic
 */
import { config, describeConfig } from '../src/lib/config';
import { tierLabel, type PriorityTier } from '../src/lib/domain/thresholds';
import type { DiscoveryMode } from '../src/lib/domain/types';
import { runPipeline } from '../src/lib/pipeline/orchestrator';
import { formatTimecode } from '../src/lib/youtube/duration';

interface CliArgs {
  mode: DiscoveryMode;
  topic: string | null;
  channelIds: string[];
  maxEpisodes: number | undefined;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: 'topic',
    topic: null,
    channelIds: [],
    maxEpisodes: undefined,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case '--mode':
        if (
          value === 'topic' ||
          value === 'tracked_channels' ||
          value === 'archive' ||
          value === 'trending'
        ) {
          args.mode = value;
        }
        i += 1;
        break;
      case '--topic':
        args.topic = value ?? null;
        i += 1;
        break;
      case '--channel':
        if (value) args.channelIds.push(value);
        i += 1;
        break;
      case '--max':
        args.maxEpisodes = value ? Number.parseInt(value, 10) : undefined;
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
  const summary = describeConfig();

  console.log('AI Podcast Producer Assistant - pipeline run');
  console.log(`  discovery : ${summary.youtube}`);
  console.log(`  scoring   : ${summary.scoring}${summary.defaultProvider ? ` (${summary.defaultProvider})` : ''}`);
  for (const agent of summary.agents) {
    console.log(`    - ${agent.label.padEnd(24)} ${agent.providerLabel}${agent.model ? ` / ${agent.model}` : ''}`);
  }
  console.log('');

  if (args.mode === 'topic' && !args.topic) {
    console.error('Error: --topic is required for topic mode.');
    process.exit(1);
  }

  const result = await runPipeline({
    mode: args.mode,
    topic: args.mode === 'trending' ? undefined : (args.topic ?? undefined),
    channelIds: args.channelIds.length > 0 ? args.channelIds : undefined,
    maxEpisodes: args.maxEpisodes,
    force: args.force,
  });

  console.log(`Run #${result.runId} finished in ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  discovery source : ${result.discoverySource}`);
  if (result.searchQueries.length > 0) {
    console.log(`  queries          : ${result.searchQueries.join(' | ')}`);
  }
  console.log(`  episodes found   : ${result.episodesDiscovered}`);
  console.log(`  episodes analysed: ${result.episodesAnalysed}`);
  console.log(`  episodes skipped : ${result.episodesSkipped}`);
  console.log(`  clips found      : ${result.clipsFound}`);
  console.log(
    `  ai usage         : ${result.aiUsage.calls} calls, ${result.aiUsage.inputTokens} in / ${result.aiUsage.outputTokens} out tokens`,
  );

  console.log('\nThreshold breakdown');
  for (const [tier, count] of Object.entries(result.tierCounts)) {
    if (count > 0) console.log(`  ${tierLabel(tier as PriorityTier).padEnd(22)} ${count}`);
  }

  console.log('\nEpisode ranking');
  for (const entry of result.results) {
    const status = entry.analysed ? `${entry.clips.length} clips` : `skipped`;
    console.log(
      `  [${String(Math.round(entry.opportunity.score)).padStart(3)}] ${entry.episode.title.slice(0, 62).padEnd(64)} ${status}`,
    );
    if (!entry.analysed && entry.skipReason) {
      console.log(`         reason: ${entry.skipReason}`);
    }
  }

  const topClips = result.results
    .flatMap((entry) => entry.clips.map((clip) => ({ clip, episode: entry.episode })))
    .sort((a, b) => b.clip.finalScore - a.clip.finalScore)
    .slice(0, 12);

  if (topClips.length > 0) {
    console.log('\nTop clips');
    for (const { clip, episode } of topClips) {
      console.log(
        `  ${String(clip.finalScore).padStart(3)} / ${String(clip.confidence).padStart(3)}% ` +
          `${formatTimecode(clip.startSec)}-${formatTimecode(clip.endSec)} ` +
          `[${clip.category}] ${clip.title}`,
      );
      console.log(`        episode: ${episode.title.slice(0, 70)}`);
      console.log(`        why: ${clip.whyThisWorks.join(', ')}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings');
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }

  console.log(`\nDatabase: ${process.env.DATABASE_PATH ?? 'data/content-miner.db'}`);
  console.log(`Clip threshold: ${config.pipeline.clipScoreThreshold}`);
}

main().catch((error) => {
  console.error('Pipeline failed:', error);
  process.exit(1);
});
