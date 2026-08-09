import type { ProviderId } from './catalog';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxOutputTokens: number;
  /** Ask the provider to guarantee syntactically valid JSON where supported. */
  jsonMode: boolean;
  signal?: AbortSignal;
  /**
   * Provider-specific body fields (e.g. `{ thinking: { type: 'disabled' } }`
   * for the local 9router DeepSeek channel). Optional and non-destructive:
   * absent keeps the exact legacy body.
   */
  extraBody?: Record<string, unknown>;
}

export interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
  model: string;
  providerId: ProviderId;
}

/** One wire protocol implementation. */
export interface ChatTransport {
  readonly providerId: ProviderId;
  complete(request: ChatRequest): Promise<ChatResult>;
}

export class AiProviderError extends Error {
  readonly providerId: ProviderId;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(params: {
    message: string;
    providerId: ProviderId;
    status?: number | null;
    retryable?: boolean;
  }) {
    super(params.message);
    this.name = 'AiProviderError';
    this.providerId = params.providerId;
    this.status = params.status ?? null;
    this.retryable = params.retryable ?? false;
  }
}

/**
 * 429 and 5xx are worth retrying; 4xx client errors are not - a malformed
 * request or a bad key will fail identically on every attempt.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
