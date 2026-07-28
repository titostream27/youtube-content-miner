/**
 * Delete all pipeline data, keeping tracked channels.
 *
 * Used when the scoring model changes: old scores are no longer comparable to
 * new ones, and a mixed library would make the threshold tiers meaningless.
 */
import { getDb } from '../src/lib/db/client';

const db = getDb();

const deleted = db.transaction(() => {
  const counts = {
    clip_performance: db.prepare('DELETE FROM clip_performance').run().changes,
    clip_feedback: db.prepare('DELETE FROM clip_feedback').run().changes,
    clips: db.prepare('DELETE FROM clips').run().changes,
    transcripts: db.prepare('DELETE FROM transcripts').run().changes,
    episodes: db.prepare('DELETE FROM episodes').run().changes,
    runs: db.prepare('DELETE FROM runs').run().changes,
  };
  return counts;
})();

for (const [table, rows] of Object.entries(deleted)) {
  console.log(`  ${table.padEnd(18)} ${rows} rows deleted`);
}

console.log('\nTracked channels were preserved.');
