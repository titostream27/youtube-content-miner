import { config, describeConfig } from '@/lib/config';
import { AGENT_ROLES, AGENT_ROLE_DEFINITIONS } from '@/lib/ai/agents/roles';
import { PROVIDER_CATALOG, resolveProviderRuntime } from '@/lib/ai/providers/catalog';
import { resolveAgent } from '@/lib/ai/client';
import { listChannels, listTrackedChannels } from '@/lib/db/repositories/channels';
import { suggestedChannels } from '@/lib/youtube/discovery';
import { DiscoveryForm } from '@/components/discovery-form';
import { TrackedChannels } from '@/components/tracked-channels';

export const dynamic = 'force-dynamic';

/** PRD Step 1 - the discovery surface, with all three modes. */
export default function DiscoverPage() {
  const summary = describeConfig();
  const tracked = listTrackedChannels(false);

  // Channels we already know about, plus demo suggestions when running without a
  // YouTube key, so archive mining always has a target to point at.
  const known = listChannels();
  const channelOptions = [
    ...known.map((channel) => ({ channelId: channel.channelId, title: channel.title })),
    ...suggestedChannels()
      .filter((suggestion) => !known.some((channel) => channel.channelId === suggestion.channelId))
      .map((channel) => ({ channelId: channel.channelId, title: channel.title })),
  ];

  const providers = PROVIDER_CATALOG.map((definition) => {
    const runtime = resolveProviderRuntime(definition.id);
    return {
      id: definition.id,
      label: definition.label,
      configured: runtime.configured,
    };
  });

  const agents = AGENT_ROLES.map((role) => {
    const resolved = resolveAgent(role);
    return {
      role,
      label: AGENT_ROLE_DEFINITIONS[role].label,
      purpose: AGENT_ROLE_DEFINITIONS[role].purpose,
      provider: resolved.providerId,
      model: resolved.model,
      active: resolved.active,
    };
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Discovery</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          No YouTube URLs required. Give the pipeline a topic, a watch list, or a channel to mine,
          and it decides which episodes are worth paying to analyse before spending anything on
          transcription.
        </p>
      </div>

      {summary.youtube === 'demo' ? (
        <p className="rounded-lg bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200/90 ring-1 ring-inset ring-amber-500/20">
          <strong className="font-semibold">Demo catalogue.</strong> No{' '}
          <code className="font-mono">YOUTUBE_API_KEY</code> is set, so discovery returns a small
          synthetic podcast catalogue instead of live results. Every other stage - opportunity
          scoring, segmentation, clip scoring, thresholds, export - runs exactly as it would in
          production.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <DiscoveryForm
          providers={providers}
          agents={agents}
          trackedChannels={tracked.map((entry) => ({
            channelId: entry.channelId,
            title: entry.channel?.title ?? entry.label ?? entry.channelId,
          }))}
          channelOptions={channelOptions}
          defaults={{
            maxEpisodes: config.pipeline.maxEpisodesPerRun,
            episodeThreshold: config.pipeline.episodeScoreThreshold,
            clipThreshold: config.pipeline.clipScoreThreshold,
          }}
        />

        <div className="space-y-6">
          <TrackedChannels initial={tracked} demoMode={summary.youtube === 'demo'} />

          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-100">Cost controls</h2>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              Two gates keep a run affordable. The Episode Opportunity Score decides which episodes
              get a transcript at all, and the per-run analysis cap limits spend even when discovery
              finds forty good candidates.
            </p>
            <dl className="mt-3 space-y-1.5 text-[11px]">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Episodes analysed per run</dt>
                <dd className="numeric text-slate-300">
                  {config.pipeline.maxEpisodesAnalysedPerRun}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Moments scored per episode</dt>
                <dd className="numeric text-slate-300">
                  {config.pipeline.maxScoredSegmentsPerEpisode}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Moment length</dt>
                <dd className="numeric text-slate-300">
                  {config.pipeline.segment.minDurationSec}-{config.pipeline.segment.maxDurationSec}s
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
