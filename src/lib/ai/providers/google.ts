import type { ProviderRuntime } from './catalog';
import {
  AiProviderError,
  isRetryableStatus,
  type ChatRequest,
  type ChatResult,
  type ChatTransport,
} from './types';

/**
 * Google Gemini `generateContent` transport.
 *
 * Protocol differences: turns are `contents` with `parts`, the assistant role is
 * called `model`, the system prompt is `systemInstruction`, and JSON mode is
 * requested through `generationConfig.responseMimeType`.
 */

interface GenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
  error?: { message?: string };
}

export function createGoogleTransport(runtime: ProviderRuntime): ChatTransport {
  const providerId = runtime.definition.id;

  return {
    providerId,

    async complete(request: ChatRequest): Promise<ChatResult> {
      if (!runtime.apiKey) {
        throw new AiProviderError({
          message: 'GOOGLE_API_KEY is not set',
          providerId,
        });
      }

      const systemPrompt = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');

      const contents = request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        }));

      const url = `${runtime.baseUrl}/models/${encodeURIComponent(
        request.model,
      )}:generateContent?key=${encodeURIComponent(runtime.apiKey)}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents,
            systemInstruction:
              systemPrompt.length > 0 ? { parts: [{ text: systemPrompt }] } : undefined,
            generationConfig: {
              temperature: request.temperature,
              maxOutputTokens: request.maxOutputTokens,
              responseMimeType: request.jsonMode ? 'application/json' : 'text/plain',
            },
          }),
          signal: request.signal,
          cache: 'no-store',
        });
      } catch (error) {
        throw new AiProviderError({
          message: `google request failed: ${
            error instanceof Error ? error.message : 'unknown network error'
          }`,
          providerId,
          retryable: true,
        });
      }

      const payload = (await response.json().catch(() => null)) as GenerateContentResponse | null;

      if (!response.ok) {
        throw new AiProviderError({
          message: payload?.error?.message ?? `google returned ${response.status}`,
          providerId,
          status: response.status,
          retryable: isRetryableStatus(response.status),
        });
      }

      const text = (payload?.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');

      if (text.trim().length === 0) {
        const finishReason = payload?.candidates?.[0]?.finishReason;
        throw new AiProviderError({
          message: `google returned an empty completion${
            finishReason ? ` (finishReason: ${finishReason})` : ''
          }`,
          providerId,
          // MAX_TOKENS is worth one retry with a smaller batch; a safety block is not.
          retryable: finishReason !== 'SAFETY',
        });
      }

      return {
        text,
        usage: {
          inputTokens: payload?.usageMetadata?.promptTokenCount ?? null,
          outputTokens: payload?.usageMetadata?.candidatesTokenCount ?? null,
        },
        model: payload?.modelVersion ?? request.model,
        providerId,
      };
    },
  };
}
