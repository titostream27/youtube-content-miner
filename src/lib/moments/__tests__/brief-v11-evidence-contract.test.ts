import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface G1Episode {
  episode_index: number;
  video_id: string;
  duration_sec: number;
  utterance_count: number;
  acquisition_status: string;
}

describe('Brief V11 evidence contracts', () => {
  it('keeps the G1 manifest at exactly ten usable unique real episodes', () => {
    const path = resolve(process.cwd(), 'docs/evidence/brief-v11-g1-corpus.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      usable_unique_episode_count: number;
      episodes: G1Episode[];
      gate_verdict: string;
    };

    expect(manifest.usable_unique_episode_count).toBe(10);
    expect(manifest.episodes).toHaveLength(10);
    expect(new Set(manifest.episodes.map((episode) => episode.video_id)).size).toBe(10);
    for (const [index, episode] of manifest.episodes.entries()) {
      expect(episode.episode_index).toBe(index + 1);
      expect(episode.video_id).not.toMatch(/^demo-/);
      expect(Number.isFinite(episode.duration_sec)).toBe(true);
      expect(episode.duration_sec).toBeGreaterThan(0);
      expect(episode.utterance_count).toBeGreaterThan(0);
      expect(episode.acquisition_status).toBe('usable');
    }
    expect(manifest.gate_verdict).toBe('PASS');
  });

  it('keeps G2 evidence as ten JSONL episode records plus a zero-negative summary', () => {
    const path = resolve(process.cwd(), 'docs/evidence/brief-v11-g2-production-summary.jsonl');
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const episodes = rows.filter((row) => typeof row.episode_index === 'number');
    const summary = rows.find((row) => row.type === 'EVAL_DONE');

    expect(episodes).toHaveLength(10);
    expect(new Set(episodes.map((row) => row.video_id)).size).toBe(10);
    for (const row of episodes) {
      expect(row.ok).toBe(true);
      expect(row.acquisition_status).toBe('usable');
      expect(row.negative_duration_count).toBe(0);
      expect(typeof row.rough_candidate_count).toBe('number');
      expect(typeof row.accepted_count).toBe('number');
    }
    expect(summary).toMatchObject({
      total: 10,
      usable_unique_episode_count: 10,
      evaluated_count: 10,
      negative_duration_count: 0,
    });
  });
});
