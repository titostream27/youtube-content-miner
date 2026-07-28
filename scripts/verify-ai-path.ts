/**
 * Exercise the full AI agent path against a local mock provider.
 *
 * Demo mode proves the heuristic fallback works. This proves the other half:
 * provider transport, JSON recovery, zod validation, per-agent routing, the
 * triage blend, boundary trimming, and LLM-tier confidence - none of which the
 * heuristic path touches.
 *
 *   npx tsx scripts/verify-ai-path.ts
 */
import { createServer } from 'node:http';

const MOCK_PORT = 3222;

/** Pull the `index: N` values out of a prompt so replies line up with requests. */
function indexesFrom(text: string): number[] {
  return [...text.matchAll(/index:\s*(\d+)/g)].map((match) => Number(match[1]));
}

function videoIdsFrom(text: string): string[] {
  return [...text.matchAll(/videoId:\s*(\S+)/g)].map((match) => match[1]!);
}

/**
 * Deterministic pseudo-scores that still vary per segment, so we can confirm the
 * aggregation model spreads results across tiers rather than flattening them.
 */
function scoresFor(index: number): Record<string, number> {
  const wave = (offset: number, spread: number): number =>
    Math.max(5, Math.min(99, 60 + Math.round(Math.sin(index * 1.7 + offset) * spread)));

  return {
    hook: wave(0.2, 34),
    curiosity: wave(1.1, 26),
    emotion: wave(2.3, 30),
    storytelling: wave(0.7, 32),
    standalone: wave(1.9, 28),
    shareability: wave(2.9, 24),
    clarity: wave(0.4, 22),
    controversy: wave(3.4, 30),
    teachingValue: wave(1.4, 28),
    entertainment: wave(2.1, 26),
  };
}

function replyFor(system: string, user: string): unknown {
  if (system.includes('discovery researcher')) {
    return {
      searchQueries: ['mock query alpha', 'mock query beta'],
      channelHints: ['Mock Show'],
      relatedTopics: ['adjacent topic'],
      rationale: 'Mock expansion from the verification harness.',
    };
  }

  if (system.includes('episode triage analyst')) {
    return {
      episodes: videoIdsFrom(user).map((videoId, position) => ({
        videoId,
        topicFit: 60 + ((position * 13) % 35),
        expectedClipDensity: 55 + ((position * 17) % 40),
        isPodcastEpisode: true,
        reason: 'Mock triage judgement.',
      })),
    };
  }

  if (system.includes('moment detection editor')) {
    return {
      segments: indexesFrom(user).map((index) => ({
        index,
        // Drop one in five to prove the filter is applied.
        keep: index % 5 !== 4,
        trimStartSec: index % 3 === 0 ? 4 : 0,
        trimEndSec: index % 4 === 0 ? 3 : 0,
        reason: 'Mock refinement.',
      })),
    };
  }

  if (system.includes('short-form content producer')) {
    return {
      clips: indexesFrom(user).map((index) => ({
        index,
        title: `Mock scored moment ${index}`,
        category: ['Business', 'Psychology', 'Finance', 'Funny'][index % 4],
        scores: scoresFor(index),
        whyThisWorks: ['Strong hook', 'Unexpected statement', 'Clear ending'],
        suggestedHook: 'Mock hook line.',
        suggestedCaption: 'Mock caption.',
        editingNotes: 'Mock editing notes.',
        certainty: 0.7 + (index % 4) * 0.07,
      })),
    };
  }

  if (system.includes('publish-ready metadata')) {
    return {
      clips: indexesFrom(user).map((index) => ({
        index,
        title: `Polished title ${index}`,
        suggestedHook: 'Polished hook line.',
        suggestedCaption: 'Polished caption.',
        editingNotes: 'Polished editing notes.',
      })),
    };
  }

  return {};
}

const callsByAgent = new Map<string, number>();

function classify(system: string): string {
  if (system.includes('discovery researcher')) return 'discovery';
  if (system.includes('episode triage analyst')) return 'episode_triage';
  if (system.includes('moment detection editor')) return 'moment_detection';
  if (system.includes('short-form content producer')) return 'clip_scoring';
  if (system.includes('publish-ready metadata')) return 'clip_metadata';
  return 'unknown';
}

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });

  request.on('end', () => {
    if (!request.url?.includes('/chat/completions')) {
      response.writeHead(404).end('{}');
      return;
    }

    const parsed = JSON.parse(body) as {
      messages: { role: string; content: string }[];
      model: string;
    };

    const system = parsed.messages.find((message) => message.role === 'system')?.content ?? '';
    const user = parsed.messages.find((message) => message.role === 'user')?.content ?? '';

    const agent = classify(system);
    callsByAgent.set(agent, (callsByAgent.get(agent) ?? 0) + 1);

    const payload = {
      model: parsed.model,
      choices: [{ message: { content: JSON.stringify(replyFor(system, user)) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 400 },
    };

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(MOCK_PORT, '127.0.0.1', resolve));

  // Environment must be set before config.ts is imported, since it reads once.
  process.env.DEMO_MODE = '1';
  process.env.DATABASE_PATH = 'data/ai-verify.db';
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'mock-key';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
  process.env.OPENAI_MODEL = 'mock-model-1';
  // Route one agent elsewhere to prove per-role overrides resolve independently.
  process.env.AGENT_CLIP_METADATA_PROVIDER = 'openai';
  process.env.AGENT_CLIP_METADATA_MODEL = 'mock-model-metadata';

  const { describeConfig } = await import('../src/lib/config');
  const { runPipeline } = await import('../src/lib/pipeline/orchestrator');
  const { tierLabel } = await import('../src/lib/domain/thresholds');
  const { PRIORITY_TIERS } = await import('../src/lib/domain/thresholds');

  const summary = describeConfig();
  console.log('Agent routing resolved from environment:');
  for (const agent of summary.agents) {
    console.log(`  ${agent.label.padEnd(24)} ${agent.providerLabel} / ${agent.model ?? '-'}`);
  }
  console.log('');

  const result = await runPipeline({ mode: 'topic', topic: 'startup', force: true });

  console.log(`Run #${result.runId}  engine=${result.engine}  source=${result.discoverySource}`);
  console.log(`  queries from discovery agent: ${result.searchQueries.join(' | ')}`);
  console.log(
    `  episodes: ${result.episodesDiscovered} found, ${result.episodesAnalysed} analysed, ${result.episodesSkipped} skipped`,
  );
  console.log(`  clips above threshold: ${result.clipsFound}`);
  console.log(
    `  ai usage: ${result.aiUsage.calls} calls, ${result.aiUsage.inputTokens} in / ${result.aiUsage.outputTokens} out`,
  );

  console.log('\nMock provider calls by agent role:');
  for (const [agent, count] of [...callsByAgent].sort()) {
    console.log(`  ${agent.padEnd(18)} ${count}`);
  }

  console.log('\nTier distribution:');
  for (const tier of PRIORITY_TIERS) {
    if (result.tierCounts[tier] > 0) {
      console.log(`  ${tierLabel(tier).padEnd(22)} ${result.tierCounts[tier]}`);
    }
  }

  const clips = result.results.flatMap((entry) => entry.clips);
  console.log('\nTop clips (verifying LLM-tier confidence and metadata refinement):');
  for (const clip of clips.sort((a, b) => b.finalScore - a.finalScore).slice(0, 6)) {
    console.log(
      `  ${String(clip.finalScore).padStart(3)} / ${String(clip.confidence).padStart(3)}%  ` +
        `[${clip.category}] ${clip.title}  (engine=${clip.engine})`,
    );
  }

  const maxConfidence = Math.max(0, ...clips.map((clip) => clip.confidence));
  const allLlm = clips.length > 0 && clips.every((clip) => clip.engine === 'llm');
  const refined = clips.filter((clip) => clip.title.startsWith('Polished title')).length;

  console.log('\nAssertions:');
  console.log(`  every clip scored by the LLM engine .......... ${allLlm ? 'yes' : 'NO'}`);
  console.log(
    `  confidence exceeds the heuristic ceiling (82) .. ${maxConfidence > 82 ? `yes (${maxConfidence})` : `NO (${maxConfidence})`}`,
  );
  console.log(`  metadata agent rewrote titles ............... ${refined}/${clips.length}`);
  console.log(
    `  all five agent roles were called ............ ${callsByAgent.size >= 5 ? 'yes' : `NO (${[...callsByAgent.keys()].join(',')})`}`,
  );

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
}

main()
  .catch((error) => {
    console.error('Verification failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
  });
