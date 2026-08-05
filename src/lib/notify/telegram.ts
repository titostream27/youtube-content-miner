/**
 * Phase 2 (Automation) — Telegram notification delivery.
 *
 * Sends short, structured messages to the operator's Telegram chat. The bot
 * token + chat id come from env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, the
 * same values the Hermes gateway uses). Delivery is best-effort: a failure
 * to reach Telegram must never break the mining/render pipeline.
 *
 * `sendTelegram` is injectable for tests (no real network).
 */

export interface TelegramMessage {
  text: string;
  /** Optional parse mode; default plain text. */
  parseMode?: 'HTML' | 'Markdown' | null;
  /** Override chat id (defaults to env). */
  chatId?: string;
}

export type SendTelegramFn = (msg: TelegramMessage) => Promise<boolean>;

const DEFAULT_TIMEOUT_MS = 8000;

export function telegramConfig(): { token: string; chatId: string; enabled: boolean } {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  return { token, chatId, enabled: Boolean(token && chatId) };
}

/** Default sender: real HTTP POST to the Telegram Bot API. */
export async function sendTelegram(
  msg: TelegramMessage,
  deps: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const { token, chatId, enabled } = telegramConfig();
  if (!enabled) return false;
  const targetChat = msg.chatId ?? chatId;
  if (!targetChat) return false;

  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: targetChat,
        text: msg.text,
        ...(msg.parseMode ? { parse_mode: msg.parseMode } : {}),
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Format a compact clip-ready notification (matches user's terse style). */
export function formatClipReady(clip: {
  title: string;
  videoUrl?: string;
  durationSec: number;
  score: number;
  tier: string;
}): string {
  const lines = [
    `🎬 ${clip.title}`,
    `⏱️ ${clip.durationSec.toFixed(0)}s | 🏆 ${clip.tier} | 💯 ${clip.score}`,
  ];
  if (clip.videoUrl) lines.push(`🔗 ${clip.videoUrl}`);
  return lines.join('\n');
}

/** Format a daily pipeline summary. */
export function formatDailySummary(stats: {
  discovered: number;
  clips: number;
  rendered: number;
  published: number;
}): string {
  return [
    '📊 *Pipeline Hari Ini*',
    `🔍 Discovery: ${stats.discovered}`,
    `✂️ Clips: ${stats.clips}`,
    `🎞️ Rendered: ${stats.rendered}`,
    `🚀 Published: ${stats.published}`,
  ].join('\n');
}
