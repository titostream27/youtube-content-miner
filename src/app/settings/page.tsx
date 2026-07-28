import { config, describeConfig } from '@/lib/config';
import { AGENT_ROLES, AGENT_ROLE_DEFINITIONS } from '@/lib/ai/agents/roles';
import { PROVIDER_CATALOG, resolveProviderRuntime } from '@/lib/ai/providers/catalog';
import { resolveAgent } from '@/lib/ai/client';
import { isSttConfigured } from '@/lib/transcript/stt';
import { Card, CardHeader, KeyValue, Pill } from '@/components/ui/primitives';
import { cn } from '@/lib/utils/cn';

export const dynamic = 'force-dynamic';

/**
 * AI agent configuration.
 *
 * Read-only on purpose. Provider credentials belong in the environment, not in a
 * database a web form can write to - but "which model is scoring my clips, and
 * which variable do I set to change it" has to be answerable without reading
 * source, so every agent shows the exact env vars it consults.
 */
export default function SettingsPage() {
  const summary = describeConfig();

  const providers = PROVIDER_CATALOG.map((definition) => ({
    definition,
    runtime: resolveProviderRuntime(definition.id),
  }));

  const configuredCount = providers.filter((entry) => entry.runtime.configured).length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">AI agents</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          The pipeline is a crew of specialised agents, not one prompt. Each does a different kind
          of thinking and each can run on a different provider and model, so you can put a cheap
          fast model on query expansion and spend the money where judgement actually matters.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Discovery
          </p>
          <p className="mt-1 text-sm font-medium text-slate-200">
            {summary.youtube === 'live' ? 'Live YouTube Data API' : 'Demo catalogue'}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {summary.youtube === 'live'
              ? 'YOUTUBE_API_KEY is set.'
              : 'Set YOUTUBE_API_KEY to query real podcasts.'}
          </p>
        </Card>

        <Card className="px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Clip scoring
          </p>
          <p className="mt-1 text-sm font-medium text-slate-200">{summary.llmModelLabel}</p>
          <p className="mt-1 text-[11px] text-slate-500">
            {summary.scoring === 'llm'
              ? 'Confidence can reach 97%.'
              : 'Deterministic engine. Confidence is capped at 82% by design.'}
          </p>
        </Card>

        <Card className="px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Speech-to-text
          </p>
          <p className="mt-1 text-sm font-medium text-slate-200">
            {isSttConfigured() ? 'Provider configured' : 'Unavailable'}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Fallback for episodes with no caption track. Audio extraction is not yet implemented.
          </p>
        </Card>
      </div>

      <section>
        <Card>
          <CardHeader
            title="Agent routing"
            description="Which model each stage of the pipeline is currently using"
          />
          <ul className="divide-y divide-[var(--color-line)]">
            {AGENT_ROLES.map((role) => {
              const definition = AGENT_ROLE_DEFINITIONS[role];
              const resolved = resolveAgent(role);

              return (
                <li key={role} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium text-slate-100">{definition.label}</h3>
                        {definition.optional ? (
                          <Pill title="The pipeline works without this agent, with reduced quality">
                            optional
                          </Pill>
                        ) : (
                          <Pill className="bg-sky-500/10 text-sky-300 ring-sky-500/20">
                            core
                          </Pill>
                        )}
                      </div>
                      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">
                        {definition.purpose}
                      </p>
                      <p className="mt-2 font-mono text-[11px] text-slate-600">
                        {definition.providerEnv} · {definition.modelEnv}
                      </p>
                    </div>

                    <div className="text-right">
                      <Pill
                        className={
                          resolved.active
                            ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                            : 'bg-slate-500/10 text-slate-400 ring-slate-500/20'
                        }
                      >
                        {resolved.providerLabel}
                      </Pill>
                      {resolved.model ? (
                        <p className="mt-1 font-mono text-[11px] text-slate-500">
                          {resolved.model}
                        </p>
                      ) : null}
                      <p className="numeric mt-0.5 text-[11px] text-slate-600">
                        temp {resolved.temperature} · max {resolved.maxOutputTokens} tok
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader
            title="Providers"
            description={`${configuredCount} of ${providers.length} reachable. Ten vendors across three wire protocols.`}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-line)] text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">API key variable</th>
                  <th className="px-3 py-2 font-medium">Default model</th>
                  <th className="px-5 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {providers.map(({ definition, runtime }) => (
                  <tr key={definition.id}>
                    <td className="px-5 py-2.5">
                      <span className="font-medium text-slate-200">{definition.label}</span>
                      <span className="ml-2 font-mono text-[11px] text-slate-600">
                        {definition.protocol}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5',
                          runtime.configured ? 'text-emerald-300' : 'text-slate-500',
                        )}
                      >
                        <span
                          className={cn(
                            'size-1.5 rounded-full',
                            runtime.configured ? 'bg-emerald-400' : 'bg-slate-600',
                          )}
                        />
                        {runtime.configured ? 'Ready' : 'No key'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500">
                      {definition.requiresApiKey ? definition.apiKeyEnv : 'not required'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-slate-400">
                      {runtime.defaultModel}
                    </td>
                    <td className="max-w-xs px-5 py-2.5 text-[11px] leading-snug text-slate-500">
                      {definition.notes}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Pipeline limits" description="Set via environment variables" />
          <dl className="px-5 py-3">
            <KeyValue label="Episodes per run" value={config.pipeline.maxEpisodesPerRun} />
            <KeyValue
              label="Episodes analysed per run"
              value={config.pipeline.maxEpisodesAnalysedPerRun}
            />
            <KeyValue
              label="Moments scored per episode"
              value={config.pipeline.maxScoredSegmentsPerEpisode}
            />
            <KeyValue label="Episode gate" value={config.pipeline.episodeScoreThreshold} />
            <KeyValue label="Clip threshold" value={config.pipeline.clipScoreThreshold} />
            <KeyValue
              label="Moment length"
              value={`${config.pipeline.segment.minDurationSec}-${config.pipeline.segment.maxDurationSec}s`}
            />
            <KeyValue label="Batch size" value={config.ai.batchSize} />
            <KeyValue label="Concurrency" value={config.ai.concurrency} />
            <KeyValue label="Max retries" value={config.ai.maxRetries} />
          </dl>
        </Card>

        <Card>
          <CardHeader title="How to point an agent at a model" />
          <div className="space-y-3 px-5 py-4 text-xs leading-relaxed text-slate-400">
            <p>
              Set one key and every agent picks it up automatically. To split roles across
              providers, override them individually:
            </p>
            <pre className="overflow-x-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
{`# one key is enough to get started
OPENAI_API_KEY=sk-...

# or spread the work by cost profile
GROQ_API_KEY=gsk_...
ANTHROPIC_API_KEY=sk-ant-...

AGENT_DISCOVERY_PROVIDER=groq
AGENT_EPISODE_TRIAGE_PROVIDER=groq
AGENT_CLIP_SCORING_PROVIDER=anthropic
AGENT_CLIP_SCORING_MODEL=claude-sonnet-4-5

# force the deterministic engine for a reproducible run
AI_PROVIDER=heuristic`}
            </pre>
            <p>
              Callers can also override per request via the{' '}
              <code className="font-mono text-slate-300">agents</code> field on{' '}
              <code className="font-mono text-slate-300">POST /api/runs</code>
              {config.ai.allowRequestOverrides
                ? '.'
                : ', but request overrides are currently disabled by AI_ALLOW_REQUEST_OVERRIDES.'}
            </p>
          </div>
        </Card>
      </section>
    </div>
  );
}
