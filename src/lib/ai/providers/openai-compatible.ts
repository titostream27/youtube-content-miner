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
        // Explicit non-streaming. Some proxies (e.g. the local 9router) default
        // to streaming and append `data: [DONE]`, which breaks response.json().
        stream: false,
      };

      // Reasoning models (e.g. the 9router `deepseek` combo -> deepseek-v4)
      // spend part of `max_tokens` on hidden reasoning, which can starve the
      // JSON output and return an empty completion. AI_REASONING_EFFORT lets
      // the operator turn that off (`none`) or tune it globally. Unset keeps
      // the old behaviour (field omitted) so non-reasoning providers are
      // unaffected.
      const reasoningEffort = process.env.AI_REASONING_EFFORT?.trim();
      if (reasoningEffort) {
        body.reasoning_effort = reasoningEffort;
      }

      if (request.jsonMode && runtime.definition.supportsJsonMode) {
        body.response_format = { type: 'json_object' };
      }

      // Provider-specific body fields (9router DeepSeek channel needs
      // `thinking: { type: 'disabled' }` to stop hidden reasoning from
      // starving the JSON output).
      if (request.extraBody) {
        Object.assign(body, request.extraBody);
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

      // Some proxies (the local 9router, observed 2026-08-08) append a
      // trailing `data: [DONE]` SSE marker even with `stream: false`.
      // Strip it before parsing so the response body stays valid JSON.
      const rawText = await response.text().catch(() => '');
      const cleanedText = rawText
        .replace(/\r?\ndata: \[DONE\]\s*$/, '')
        .replace(/}data: \[DONE\]\s*$/, '}')
        .trim();

      let payload: ChatCompletionResponse | null = null;
      try {
        payload = JSON.parse(cleanedText) as ChatCompletionResponse;
      } catch {
        payload = null;
      }

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