import { resolveProviderRuntime, type ProviderId, type ProviderRuntime } from './catalog';
import { createAnthropicTransport } from './anthropic';
import { createGoogleTransport } from './google';
import { createOpenAiCompatibleTransport } from './openai-compatible';
import type { ChatTransport } from './types';

/**
 * Transport factory. Adding a vendor that speaks an existing protocol requires
 * no change here at all - only a new entry in the catalogue.
 */
export function createTransport(runtime: ProviderRuntime): ChatTransport {
  switch (runtime.definition.protocol) {
    case 'anthropic':
      return createAnthropicTransport(runtime);
    case 'google':
      return createGoogleTransport(runtime);
    case 'openai-compatible':
      return createOpenAiCompatibleTransport(runtime);
    default: {
      const exhaustive: never = runtime.definition.protocol;
      throw new Error(`Unsupported provider protocol: ${String(exhaustive)}`);
    }
  }
}

/** Transports are stateless; cache one per provider. */
const transportCache = new Map<ProviderId, ChatTransport>();

export function getTransport(providerId: ProviderId): ChatTransport {
  const cached = transportCache.get(providerId);
  if (cached) return cached;

  const transport = createTransport(resolveProviderRuntime(providerId));
  transportCache.set(providerId, transport);
  return transport;
}

export * from './catalog';
export * from './types';
