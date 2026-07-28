import { describeConfig } from '@/lib/config';
import { AGENT_ROLES, AGENT_ROLE_DEFINITIONS } from '@/lib/ai/agents/roles';
import { PROVIDER_CATALOG, resolveProviderRuntime } from '@/lib/ai/providers/catalog';
import { resolveAgent } from '@/lib/ai/client';
import { ok, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ai/agents
 *
 * Which AI providers are reachable, and which agent is currently running on
 * which model. This is the endpoint the settings page reads, and the fastest way
 * to answer "why is my scoring still heuristic?" - it reports the exact
 * environment variable each agent looks at.
 *
 * Never returns key material, only whether a key is present.
 */
export function GET() {
  try {
    const summary = describeConfig();

    return ok({
      discovery: summary.youtube,
      scoring: summary.scoring,
      defaultProvider: summary.defaultProvider,
      speechToText: summary.stt,

      providers: PROVIDER_CATALOG.map((definition) => {
        const runtime = resolveProviderRuntime(definition.id);
        return {
          id: definition.id,
          label: definition.label,
          protocol: definition.protocol,
          configured: runtime.configured,
          requiresApiKey: definition.requiresApiKey,
          apiKeyEnv: definition.apiKeyEnv,
          modelEnv: definition.modelEnv,
          defaultModel: runtime.defaultModel,
          baseUrl: runtime.baseUrl,
          supportsJsonMode: definition.supportsJsonMode,
          notes: definition.notes,
        };
      }),

      agents: AGENT_ROLES.map((role) => {
        const definition = AGENT_ROLE_DEFINITIONS[role];
        const resolved = resolveAgent(role);
        return {
          role,
          label: definition.label,
          purpose: definition.purpose,
          optional: definition.optional,
          provider: resolved.providerId,
          providerLabel: resolved.providerLabel,
          model: resolved.model,
          temperature: resolved.temperature,
          maxOutputTokens: resolved.maxOutputTokens,
          active: resolved.active,
          providerEnv: definition.providerEnv,
          modelEnv: definition.modelEnv,
        };
      }),
    });
  } catch (error) {
    return serverError(error);
  }
}
