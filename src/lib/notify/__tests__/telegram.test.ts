import { describe, it, expect, vi } from 'vitest';
import {
  sendTelegram,
  formatClipReady,
  formatDailySummary,
  telegramConfig,
} from '@/lib/notify/telegram';

describe('telegram notifier (Phase 2 automation)', () => {
  it('returns false when not configured', async () => {
    const oldToken = process.env.TELEGRAM_BOT_TOKEN;
    const oldChat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    try {
      const ok = await sendTelegram({ text: 'hi' });
      expect(ok).toBe(false);
    } finally {
      if (oldToken) process.env.TELEGRAM_BOT_TOKEN = oldToken;
      if (oldChat) process.env.TELEGRAM_CHAT_ID = oldChat;
    }
  });

  it('posts to the Telegram API with the right payload', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    try {
      const ok = await sendTelegram({ text: 'hello', parseMode: 'Markdown' }, { fetchFn });
      expect(ok).toBe(true);
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(String(url)).toContain('api.telegram.org/bottest-token/sendMessage');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.chat_id).toBe('12345');
      expect(body.text).toBe('hello');
      expect(body.parse_mode).toBe('Markdown');
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it('returns false when the API call fails', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    try {
      const ok = await sendTelegram({ text: 'hi' }, { fetchFn });
      expect(ok).toBe(false);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  it('telegramConfig reflects env state', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'a';
    process.env.TELEGRAM_CHAT_ID = 'b';
    expect(telegramConfig().enabled).toBe(true);
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    expect(telegramConfig().enabled).toBe(false);
  });

  it('formats a clip-ready message tersely', () => {
    const msg = formatClipReady({ title: 'Why startups fail', durationSec: 42, score: 91, tier: 'high_priority', videoUrl: 'https://youtube.com/watch?v=x' });
    expect(msg).toContain('🎬 Why startups fail');
    expect(msg).toContain('42s');
    expect(msg).toContain('high_priority');
    expect(msg).toContain('youtube.com');
  });

  it('formats a daily summary', () => {
    const msg = formatDailySummary({ discovered: 12, clips: 8, rendered: 6, published: 4 });
    expect(msg).toContain('Discovery: 12');
    expect(msg).toContain('Published: 4');
  });
});
