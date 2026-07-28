/**
 * Provider catalogue.
 *
 * The product is deliberately not tied to one vendor. Discovery query
 * expansion is a cheap, high-volume task that suits a fast, inexpensive model;
 * clip scoring is a nuanced judgement task worth spending a frontier model on.
 * Locking the whole pipeline to a single provider would force one compromise
 * for both.
 *
 * Every provider here is reachable through one of three wire protocols, so
 * adding a vendor is a data change in this file rather than new transport code.
 */

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'groq'
  | 'openrouter'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'together'
  | 'ollama';

export type ProviderProtocol = 'openai-compatible' | 'anthropic' | 'google';

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  protocol: ProviderProtocol;
  /** Environment variable holding the API key. */
  apiKeyEnv: string;
  /** Environment variable that overrides the base URL. */
  baseUrlEnv: string;
  /** Environment variable that overrides the default model. */
  modelEnv: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** False for local runtimes such as Ollama. */
  requiresApiKey: boolean;
  /** True when the provider supports a strict JSON response mode. */
  supportsJsonMode: boolean;
  notes: string;
}

export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compatible',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    modelEnv: 'OPENAI_MODEL',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresApiKey: true,
    supportsJsonMode: true,
    notes: 'Strong structured-output reliability. Good default for clip scoring.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    requiresApiKey: true,
    supportsJsonMode: false,
    notes: 'Strong long-context editorial judgement. No native JSON mode; we prefill instead.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    protocol: 'google',
    apiKeyEnv: 'GOOGLE_API_KEY',
    baseUrlEnv: 'GOOGLE_BASE_URL',
    modelEnv: 'GOOGLE_MODEL',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    requiresApiKey: true,
    supportsJsonMode: true,
    notes: 'Very large context window and low cost per token for bulk segment scoring.',
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai-compatible',
    apiKeyEnv: 'GROQ_API_KEY',
    baseUrlEnv: 'GROQ_BASE_URL',
    modelEnv: 'GROQ_MODEL',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    requiresApiKey: true,
    supportsJsonMode: true,
    notes: 'Fastest inference. Best fit for discovery query expansion.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    modelEnv: 'OPENROUTER_MODEL',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    requiresApiKey: true,
    supportsJsonMode: true,
    notes: 'One key, many models. Useful for A/B testing scoring models cheaply.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai-compatible',
    apiKeyEnv: 'MISTRAL_API_KEY',
    baseUrlEnv: 'MISTRAL_BASE_URL',
    modelEnv: 'MISTRAL_MODEL',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    requiresApiKey: true,
    supportsJsonMode: true,
    notes: 'EU-hosted option for teams with data residency requirements.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true,
    supportsJsonMode: true,
    notes: 'Low cost per token. Viable for scoring very large archives.',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    protocol: 'openai-compatible',
    apiKeyEnv: 'XAI_API_KEY',
    baseUrlEnv: 'XAI_BASE_URL',
    modelEnv: 'XAI_MODEL',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    requiresApiKey: true,
    supportsJsonMode: true,
    notes: 'Alternative frontier model for scoring comparisons.',
  },
  {
    id: 'together',
    label: 'Together AI',
    protocol: 'openai-compatible',
    apiKeyEnv: 'TOGETHER_API_KEY',
    baseUrlEnv: 'TOGETHER_BASE_URL',
    modelEnv: 'TOGETHER_MODEL',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    requiresApiKey: true,
    supportsJsonMode: true,
    notes: 'Open-weight model hosting.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    protocol: 'openai-compatible',
    apiKeyEnv: 'OLLAMA_API_KEY',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    modelEnv: 'OLLAMA_MODEL',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.1:8b',
    requiresApiKey: false,
    supportsJsonMode: true,
    notes: 'Runs entirely on the operator\'s machine. No transcript leaves the host.',
  },
];

const CATALOG_BY_ID = new Map<ProviderId, ProviderDefinition>(
  PROVIDER_CATALOG.map((provider) => [provider.id, provider]),
);

export function isProviderId(value: string): value is ProviderId {
  return CATALOG_BY_ID.has(value as ProviderId);
}

export function providerDefinition(id: ProviderId): ProviderDefinition {
  const definition = CATALOG_BY_ID.get(id);
  if (!definition) throw new Error(`Unknown AI provider: ${id}`);
  return definition;
}

/** A provider definition combined with whatever the environment supplies. */
export interface ProviderRuntime {
  definition: ProviderDefinition;
  apiKey: string | null;
  baseUrl: string;
  defaultModel: string;
  configured: boolean;
}

function readEnv(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Is this provider usable right now?
 *
 * For hosted providers that is simply "is the key present". Local runtimes need
 * an explicit opt-in: Ollama requires no API key, so a naive check would report
 * it as ready on every machine even with nothing listening on the port, and the
 * UI would claim AI scoring was available when it was not.
 */
function isConfigured(definition: ProviderDefinition, apiKey: string | null): boolean {
  if (definition.requiresApiKey) return Boolean(apiKey);

  return (
    Boolean(readEnv(definition.baseUrlEnv)) ||
    readEnv('AI_PROVIDER')?.toLowerCase() === definition.id
  );
}

export function resolveProviderRuntime(id: ProviderId): ProviderRuntime {
  const definition = providerDefinition(id);
  const apiKey = readEnv(definition.apiKeyEnv);

  return {
    definition,
    apiKey,
    baseUrl: readEnv(definition.baseUrlEnv) ?? definition.defaultBaseUrl,
    defaultModel: readEnv(definition.modelEnv) ?? definition.defaultModel,
    configured: isConfigured(definition, apiKey),
  };
}

/** Providers that are actually usable right now, in catalogue order. */
export function availableProviders(): ProviderRuntime[] {
  return PROVIDER_CATALOG.map((definition) => resolveProviderRuntime(definition.id)).filter(
    (runtime) => runtime.configured,
  );
}
