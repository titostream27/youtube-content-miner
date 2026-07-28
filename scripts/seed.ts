/**
 * Populate a working dataset.
 *
 * Runs the real pipeline across several topics plus one archive-mining pass, so
 * the dashboard, clip library and episode pages all have something meaningful in
 * them on first load. Nothing here is fake: it is the same code path the app
 * uses, just invoked several times.
 *
 *   npm run db:seed
 */
import { describeConfig } from '../src/lib/config';
import { addTrackedChannel, upsertChannel } from '../src/lib/db/repositories/channels';
import { getLibraryTotals, getTierCounts } from '../src/lib/db/repositories/stats';
import { runPipeline } from '../src/lib/pipeline/orchestrator';
import { listFixtureChannels } from '../src/lib/youtube/fixtures';
import { tierLabel, type PriorityTier } from '../src/lib/domain/thresholds';

const TOPICS = [
  'artificial intelligence',
  'startup',
  'finance',
  'marketing',
  'psychology',
  'health',
  'leadership',
  'productivity',
];

async function main(): Promise<void> {
  const summary = describeConfig();
  console.log(`Seeding (discovery: ${summary.youtube}, scoring: ${summary.scoring})\n`);

  if (summary.youtube === 'demo') {
    // Register the demo channels so Mode B and Mode C have something to target.
    for (const channel of listFixtureChannels()) {
      upsertChannel(channel);
    }
    addTrackedChannel('demo-chan-signal', 'The Signal Room');
    addTrackedChannel('demo-chan-founders', 'Founders Off Record');
    console.log('Registered demo channels and tracked two of them.\n');
  }

  for (const topic of TOPICS) {
    const result = await runPipeline({ mode: 'topic', topic });
    console.log(
      `  ${topic.padEnd(24)} ${String(result.episodesDiscovered).padStart(2)} found  ` +
        `${String(result.episodesAnalysed).padStart(2)} analysed  ` +
        `${String(result.clipsFound).padStart(3)} clips`,
    );
  }

  if (summary.youtube === 'demo') {
    const archive = await runPipeline({
      mode: 'archive',
      channelIds: ['demo-chan-capital'],
    });
    console.log(
      `  ${'archive: Capital'.padEnd(24)} ${String(archive.episodesDiscovered).padStart(2)} found  ` +
        `${String(archive.episodesAnalysed).padStart(2)} analysed  ` +
        `${String(archive.clipsFound).padStart(3)} clips`,
    );
  }

  const totals = getLibraryTotals();
  const tiers = getTierCounts();

  console.log('\nLibrary');
  console.log(`  episodes discovered : ${totals.episodesDiscovered}`);
  console.log(`  episodes analysed   : ${totals.episodesAnalysed}`);
  console.log(`  episodes skipped    : ${totals.episodesSkipped}`);
  console.log(`  clips scored        : ${totals.clipsTotal}`);
  console.log(`  clips in library    : ${totals.clipsInLibrary}`);
  console.log(`  hours mined         : ${totals.hoursMined}`);

  console.log('\nThreshold breakdown');
  for (const [tier, count] of Object.entries(tiers)) {
    console.log(`  ${tierLabel(tier as PriorityTier).padEnd(22)} ${count}`);
  }
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
