import type { ProviderRuntime } from './catalog';
import {
  AiProviderError,
  isRetryableStatus,
  type ChatRequest,
  type ChatResult,
  type ChatTransport,
} from './types';

/**
 * Anthropic Messages API transport.
 *
 * Two protocol differences matter here:
 *  1. The system prompt is a top-level field, not a message.
 *  2. There is no JSON response mode. The reliable substitute is to prefill the
 *     assistant turn with an opening brace, which constrains the model to
 *     continue as a JSON object. We re-attach that brace to the response.
 */

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
  error?: { message?: string };
}

export function createAnthropicTransport(runtime: ProviderRuntime): ChatTransport {
  const providerId = runtime.definition.id;
  const apiVersion = process.env.ANTHROPIC_VERSION?.trim() || '2023-06-01';

  return {
    providerId,

    async complete(request: ChatRequest): Promise<ChatResult> {
      if (!runtime.apiKey) {
        throw new AiProviderError({
          message: 'ANTHROPIC_API_KEY is not set',
          providerId,
        });
      }

      const systemPrompt = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');

      const conversation = request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role, content: message.content }));

      // Prefill to force a JSON object continuation.
      const prefill = request.jsonMode;
      if (prefill) {
        conversation.push({ role: 'assistant', content: '{' });
      }

      let response: Response;
      try {
        response = await fetch(`${runtime.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': runtime.apiKey,
            'anthropic-version': apiVersion,
          },
          body: JSON.stringify({
            model: request.model,
            system: systemPrompt.length > 0 ? systemPrompt : undefined,
            messages: conversation,
            temperature: request.temperature,
            max_tokens: request.maxOutputTokens,
          }),
          signal: request.signal,
          cache: 'no-store',
        });
      } catch (error) {
        throw new AiProviderError({
          message: `anthropic request failed: ${
            error instanceof Error ? error.message : 'unknown network error'
          }`,
          providerId,
          retryable: true,
        });
      }

      const payload = (await response.json().catch(() => null)) as MessagesResponse | null;

      if (!response.ok) {
        throw new AiProviderError({
          message: payload?.error?.message ?? `anthropic returned ${response.status}`,
          providerId,
          status: response.status,
          retryable: isRetryableStatus(response.status),
        });
      }

      const raw = (payload?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

      if (raw.trim().length === 0) {
        throw new AiProviderError({
          message: 'anthropic returned an empty completion',
          providerId,
          retryable: true,
        });
      }

      return {
        text: prefill ? `{${raw}` : raw,
        usage: {
          inputTokens: payload?.usage?.input_tokens ?? null,
          outputTokens: payload?.usage?.output_tokens ?? null,
        },
        model: payload?.model ?? request.model,
        providerId,
      };
    },
  };
}
