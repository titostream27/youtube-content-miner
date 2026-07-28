'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import type { AgentRole } from '@/lib/ai/agents/roles';
import type { DiscoveryMode, RunSummary } from '@/lib/domain/types';
import { tierLabel, TIER_DEFINITIONS } from '@/lib/domain/thresholds';
import { formatDurationMs, pluralize } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { Card, CardHeader, Pill } from '@/components/ui/primitives';

/**
 * PRD "AI Discovery" - the three modes, plus per-agent model selection.
 *
 * The agent override panel is the practical half of multi-provider support:
 * archive-mining a 400 episode back catalogue and scoring one fresh interview
 * are very different cost problems, and the person starting the run is the one
 * who knows which they are doing.
 */

const MODES: { mode: DiscoveryMode; label: string; blurb: string }[] = [
  {
    mode: 'topic',
    label: 'Mode A · Search by topic',
    blurb:
      'Type a topic. The discovery agent expands it into the queries a researcher would run, then ranks what it finds.',
  },
  {
    mode: 'tracked_channels',
    label: 'Mode B · Tracked channels',
    blurb: 'Check your watch list for new episodes and analyse anything that clears the gate.',
  },
  {
    mode: 'archive',
    label: 'Mode C · Archive mining',
    blurb: 'Point at one channel and mine its entire back catalogue for the best moments.',
  },
];

export interface ProviderOption {
  id: string;
  label: string;
  configured: boolean;
}

export interface AgentOption {
  role: AgentRole;
  label: string;
  purpose: string;
  provider: string | null;
  model: string | null;
  active: boolean;
}

export interface ChannelOption {
  channelId: string;
  title: string;
}

export function DiscoveryForm({
  providers,
  agents,
  trackedChannels,
  channelOptions,
  defaults,
}: {
  providers: ProviderOption[];
  agents: AgentOption[];
  trackedChannels: ChannelOption[];
  channelOptions: ChannelOption[];
  defaults: { maxEpisodes: number; episodeThreshold: number; clipThreshold: number };
}) {
  const router = useRouter();

  const [mode, setMode] = useState<DiscoveryMode>('topic');
  const [topic, setTopic] = useState('');
  const [archiveChannel, setArchiveChannel] = useState(channelOptions[0]?.channelId ?? '');
  const [maxEpisodes, setMaxEpisodes] = useState(defaults.maxEpisodes);
  const [episodeThreshold, setEpisodeThreshold] = useState(defaults.episodeThreshold);
  const [clipThreshold, setClipThreshold] = useState(defaults.clipThreshold);
  const [force, setForce] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);

  const configuredProviders = providers.filter((provider) => provider.configured);

  function buildAgentOverrides(): Record<string, { provider: string }> | undefined {
    const entries = Object.entries(overrides).filter(([, provider]) => provider.length > 0);
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries.map(([role, provider]) => [role, { provider }]));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSummary(null);

    if (mode === 'topic' && topic.trim().length < 2) {
      setError('Enter a topic to search for.');
      return;
    }
    if (mode === 'archive' && !archiveChannel) {
      setError('Choose a channel to mine.');
      return;
    }
    if (mode === 'tracked_channels' && trackedChannels.length === 0) {
      setError('No channels are being tracked yet. Add one below first.');
      return;
    }

    setRunning(true);

    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode,
          topic: mode === 'topic' ? topic.trim() : undefined,
          channelIds: mode === 'archive' ? [archiveChannel] : undefined,
          maxEpisodes,
          episodeScoreThreshold: episodeThreshold,
          clipScoreThreshold: clipThreshold,
          force,
          agents: buildAgentOverrides(),
        }),
      });

      const body = (await response.json()) as RunSummary | { error?: string; details?: unknown };

      if (!response.ok) {
        throw new Error(
          ('error' in body && body.error) || `Run failed with status ${response.status}`,
        );
      }

      setSummary(body as RunSummary);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Start a discovery run"
          description="The user supplies a topic. Everything after that is automatic."
        />

        <form onSubmit={submit} className="space-y-5 px-5 py-5">
          {/* Mode selector */}
          <div className="grid gap-2 sm:grid-cols-3">
            {MODES.map((option) => (
              <button
                key={option.mode}
                type="button"
                onClick={() => setMode(option.mode)}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  mode === option.mode
                    ? 'border-sky-500/40 bg-sky-500/10'
                    : 'border-[var(--color-line)] hover:border-slate-600 hover:bg-[var(--color-surface-hover)]',
                )}
              >
                <span
                  className={cn(
                    'block text-xs font-semibold',
                    mode === option.mode ? 'text-sky-200' : 'text-slate-300',
                  )}
                >
                  {option.label}
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-slate-500">
                  {option.blurb}
                </span>
              </button>
            ))}
          </div>

          {/* Mode-specific input */}
          {mode === 'topic' ? (
            <div>
              <label
                htmlFor="topic"
                className="block text-[11px] font-medium uppercase tracking-wider text-slate-500"
              >
                Topic
              </label>
              <input
                id="topic"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="artificial intelligence"
                className="mt-1.5 w-full rounded-lg border border-[var(--color-line)] bg-black/25 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-500/50 focus:outline-none"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {['artificial intelligence', 'startup', 'marketing', 'finance', 'psychology', 'health'].map(
                  (suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setTopic(suggestion)}
                      className="rounded-md bg-slate-500/10 px-2 py-0.5 text-[11px] text-slate-400 ring-1 ring-inset ring-slate-500/20 hover:bg-slate-500/20 hover:text-slate-200"
                    >
                      {suggestion}
                    </button>
                  ),
                )}
              </div>
            </div>
          ) : null}

          {mode === 'archive' ? (
            <div>
              <label
                htmlFor="archiveChannel"
                className="block text-[11px] font-medium uppercase tracking-wider text-slate-500"
              >
                Channel
              </label>
              <select
                id="archiveChannel"
                value={archiveChannel}
                onChange={(event) => setArchiveChannel(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-[var(--color-line)] bg-black/25 px-3 py-2 text-sm text-slate-200 focus:border-sky-500/50 focus:outline-none"
              >
                {channelOptions.length === 0 ? (
                  <option value="">No channels known yet</option>
                ) : null}
                {channelOptions.map((channel) => (
                  <option key={channel.channelId} value={channel.channelId}>
                    {channel.title}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] text-slate-500">
                Archive mining walks the uploads playlist, which costs 1 quota unit per 50 videos
                instead of 100 per search page.
              </p>
            </div>
          ) : null}

          {mode === 'tracked_channels' ? (
            <div className="rounded-lg bg-black/20 px-3 py-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Watching {pluralize(trackedChannels.length, 'channel')}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {trackedChannels.length === 0 ? (
                  <span className="text-[11px] text-slate-500">
                    Nothing tracked yet. Add a channel below.
                  </span>
                ) : (
                  trackedChannels.map((channel) => <Pill key={channel.channelId}>{channel.title}</Pill>)
                )}
              </div>
            </div>
          ) : null}

          {/* Thresholds */}
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              id="maxEpisodes"
              label="Max episodes"
              hint="Discovery result cap"
              value={maxEpisodes}
              min={1}
              max={50}
              onChange={setMaxEpisodes}
            />
            <NumberField
              id="episodeThreshold"
              label="Episode gate"
              hint="Below this, never transcribed"
              value={episodeThreshold}
              min={0}
              max={100}
              onChange={setEpisodeThreshold}
            />
            <NumberField
              id="clipThreshold"
              label="Clip threshold"
              hint="Minimum score to surface"
              value={clipThreshold}
              min={0}
              max={100}
              onChange={setClipThreshold}
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={force}
              onChange={(event) => setForce(event.target.checked)}
              className="size-3.5 rounded border-slate-600 bg-black/30"
            />
            Re-analyse episodes that already have clips
          </label>

          {/* Per-agent provider routing */}
          <div className="rounded-lg border border-[var(--color-line)]">
            <button
              type="button"
              onClick={() => setShowAgents(!showAgents)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
            >
              <span className="text-xs font-medium text-slate-300">
                AI agent routing
                <span className="ml-2 font-normal text-slate-500">
                  {configuredProviders.length === 0
                    ? 'no providers configured - heuristic engine'
                    : `${configuredProviders.length} provider${configuredProviders.length === 1 ? '' : 's'} available`}
                </span>
              </span>
              <span className="text-[11px] text-slate-500">{showAgents ? 'Hide' : 'Show'}</span>
            </button>

            {showAgents ? (
              <div className="space-y-3 border-t border-[var(--color-line)] px-3 py-3">
                {configuredProviders.length === 0 ? (
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    No AI provider keys are set, so every agent falls back to the deterministic
                    heuristic engine. The pipeline still runs end to end.{' '}
                    <Link href="/settings" className="text-sky-400 hover:underline">
                      See how to configure a provider
                    </Link>
                    .
                  </p>
                ) : (
                  agents.map((agent) => (
                    <div key={agent.role} className="grid gap-2 sm:grid-cols-[1fr_180px]">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-slate-300">{agent.label}</p>
                        <p className="text-[11px] leading-snug text-slate-500">{agent.purpose}</p>
                      </div>
                      <select
                        value={overrides[agent.role] ?? ''}
                        onChange={(event) =>
                          setOverrides({ ...overrides, [agent.role]: event.target.value })
                        }
                        className="h-8 self-start rounded-md border border-[var(--color-line)] bg-black/25 px-2 text-[11px] text-slate-300 focus:border-sky-500/50 focus:outline-none"
                      >
                        <option value="">
                          Default ({agent.active ? (agent.model ?? agent.provider) : 'heuristic'})
                        </option>
                        {configuredProviders.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.label}
                          </option>
                        ))}
                        <option value="heuristic">Heuristic engine</option>
                      </select>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>

          {error ? (
            <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-inset ring-rose-500/20">
              {error}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={running}
              className="rounded-lg bg-sky-500/20 px-4 py-2 text-sm font-medium text-sky-100 ring-1 ring-inset ring-sky-500/40 transition-colors hover:bg-sky-500/30 disabled:opacity-50"
            >
              {running ? 'Running pipeline...' : 'Run discovery'}
            </button>
            {running ? (
              <span className="text-[11px] text-slate-500">
                Discovering, ranking, transcribing and scoring. This can take a minute.
              </span>
            ) : null}
          </div>
        </form>
      </Card>

      {summary ? <RunResult summary={summary} /> : null}
    </div>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[11px] font-medium uppercase tracking-wider text-slate-500"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
        }}
        className="numeric mt-1.5 w-full rounded-lg border border-[var(--color-line)] bg-black/25 px-3 py-2 text-sm text-slate-200 focus:border-sky-500/50 focus:outline-none"
      />
      <p className="mt-1 text-[11px] text-slate-500">{hint}</p>
    </div>
  );
}

/** Run report. Shows what was skipped and why, not just what was found. */
function RunResult({ summary }: { summary: RunSummary }) {
  return (
    <Card>
      <CardHeader
        title={`Run #${summary.runId} complete`}
        description={`${formatDurationMs(summary.durationMs)} · ${summary.discoverySource === 'demo' ? 'demo catalogue' : 'live YouTube'} · ${summary.engine === 'llm' ? 'AI scored' : 'heuristic scoring'}`}
        action={
          <Link
            href="/clips"
            className="rounded-lg bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-200 ring-1 ring-inset ring-sky-500/30 hover:bg-sky-500/25"
          >
            Open clip library
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-4">
        <Metric label="Found" value={summary.episodesDiscovered} />
        <Metric label="Analysed" value={summary.episodesAnalysed} />
        <Metric label="Skipped" value={summary.episodesSkipped} />
        <Metric label="Clips" value={summary.clipsFound} />
      </div>

      {summary.searchQueries.length > 0 ? (
        <div className="border-t border-[var(--color-line)] px-5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Queries run
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {summary.searchQueries.map((query) => (
              <Pill key={query}>{query}</Pill>
            ))}
          </div>
        </div>
      ) : null}

      {summary.clipsFound > 0 ? (
        <div className="border-t border-[var(--color-line)] px-5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Threshold breakdown
          </p>
          <div className="mt-1.5 flex flex-wrap gap-3">
            {TIER_DEFINITIONS.filter((definition) => summary.tierCounts[definition.tier] > 0).map(
              (definition) => (
                <span key={definition.tier} className="text-xs text-slate-400">
                  <span className="numeric font-semibold text-slate-200">
                    {summary.tierCounts[definition.tier]}
                  </span>{' '}
                  {tierLabel(definition.tier)}
                </span>
              ),
            )}
          </div>
        </div>
      ) : null}

      <div className="border-t border-[var(--color-line)] px-5 py-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
          Episode ranking
        </p>
        <ul className="mt-2 space-y-1.5">
          {summary.results.map((result) => (
            <li key={result.episode.videoId} className="flex items-start gap-3 text-xs">
              <span
                className={cn(
                  'numeric w-8 shrink-0 text-right font-semibold tabular-nums',
                  result.analysed ? 'text-slate-200' : 'text-slate-600',
                )}
              >
                {Math.round(result.opportunity.score)}
              </span>
              <span className="min-w-0 flex-1">
                <Link
                  href={`/episodes/${result.episode.videoId}`}
                  className="text-slate-300 hover:underline"
                >
                  {result.episode.title}
                </Link>
                {result.analysed ? (
                  <span className="ml-2 text-slate-500">
                    {pluralize(result.clips.length, 'clip')} from {result.segmentCount} moments
                  </span>
                ) : (
                  <span className="ml-2 text-slate-600">{result.skipReason}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {summary.warnings.length > 0 ? (
        <div className="border-t border-[var(--color-line)] px-5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-amber-400/80">
            Warnings
          </p>
          <ul className="mt-1.5 space-y-1">
            {summary.warnings.map((warning) => (
              <li key={warning} className="text-[11px] leading-relaxed text-slate-500">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="numeric mt-0.5 text-xl font-semibold tabular-nums text-slate-100">{value}</p>
    </div>
  );
}
