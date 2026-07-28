import type { ProviderRuntime } from './catalog';
import {
  AiProviderError,
  isRetryableStatus,
  type ChatRequest,
  type ChatResult,
  type ChatTransport,
} from './types';

/**
 * Transport for every provider that speaks the OpenAI chat completions
 * protocol: OpenAI, Groq, OpenRouter, Mistral, DeepSeek, xAI, Together and
 * Ollama. One implementation covers eight vendors.
 */

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string };
}

export function createOpenAiCompatibleTransport(runtime: ProviderRuntime): ChatTransport {
  const providerId = runtime.definition.id;

  return {
    providerId,

    async complete(request: ChatRequest): Promise<ChatResult> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };

      if (runtime.apiKey) {
        headers.authorization = `Bearer ${runtime.apiKey}`;
      }

      // OpenRouter asks integrators to identify themselves.
      if (providerId === 'openrouter') {
        headers['x-title'] = 'YouTube Content Miner';
      }

      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxOutputTokens,
      };

      if (request.jsonMode && runtime.definition.supportsJsonMode) {
        body.response_format = { type: 'json_object' };
      }

      let response: Response;
      try {
        response = await fetch(`${runtime.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
          cache: 'no-store',
        });
      } catch (error) {
        throw new AiProviderError({
          message: `${providerId} request failed: ${
            error instanceof Error ? error.message : 'unknown network error'
          }`,
          providerId,
          retryable: true,
        });
      }

      const payload = (await response.json().catch(() => null)) as ChatCompletionResponse | null;

      if (!response.ok) {
        throw new AiProviderError({
          message: payload?.error?.message ?? `${providerId} returned ${response.status}`,
          providerId,
          status: response.status,
          retryable: isRetryableStatus(response.status),
        });
      }

      const text = payload?.choices?.[0]?.message?.content ?? '';
      if (text.trim().length === 0) {
        throw new AiProviderError({
          message: `${providerId} returned an empty completion`,
          providerId,
          retryable: true,
        });
      }

      return {
        text,
        usage: {
          inputTokens: payload?.usage?.prompt_tokens ?? null,
          outputTokens: payload?.usage?.completion_tokens ?? null,
        },
        model: payload?.model ?? request.model,
        providerId,
      };
    },
  };
}
