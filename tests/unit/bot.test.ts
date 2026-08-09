import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot.js';
import { loadConfig, type Config } from '../../src/config.js';
import { MemoryRepository } from '../../src/db.js';
import type { NewApiAccount, NewApiStatus } from '../../src/types.js';

const account: NewApiAccount = {
  id: 42, username: 'alice', displayName: 'Alice', telegramId: '1001', status: 1,
  group: 'default', quota: 500000, usedQuota: 1000, requestCount: 3,
};
const status: NewApiStatus = { quotaPerUnit: 500000, quotaDisplayType: 'USD' };

function config(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test', BOT_MODE: 'polling', TELEGRAM_BOT_TOKEN: 'test-token',
    NEW_API_BASE_URL: 'https://new-api.example.test', NEW_API_INTEGRATION_MODE: 'bridge',
    NEW_API_INTEGRATION_SECRET: 'integration-secret-123456',
    ...overrides,
  });
}

function messageUpdate(updateId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1001, type: 'private' },
      from: { id: 1001, is_bot: false, first_name: 'Alice', language_code: 'zh' },
      text,
      entities: text.startsWith('/') ? [{ offset: 0, length: text.split(' ')[0]?.length ?? 0, type: 'bot_command' }] : [],
    },
  };
}

describe('telegram bot commands', () => {
  it('binds through the Bridge and deduplicates a repeated update', async () => {
    const repository = new MemoryRepository();
    const sent: string[] = [];
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }),
      newApi: {
        getStatus: async () => status,
        resolveAccountByTelegramId: async () => account,
        getAccountById: async () => account,
        getUsage: async () => ({ quota: 1000, rpm: 1, tpm: 2 }),
        getSubscriptions: async () => [],
        getNotice: async () => '',
      } as never,
    });
    let nextMessageId = 100;
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 7847736904, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push(String((payload as { text?: string }).text ?? ''));
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: nextMessageId++, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(1, '/bind') as never);
    await bot.handleUpdate(messageUpdate(1, '/bind') as never);

    expect(await repository.getBinding('1001')).toMatchObject({ newApiUserId: 42, status: 'active' });
    expect(sent.filter((text) => text.includes('账号绑定成功'))).toHaveLength(1);
  });

  it('supports the usage range argument and rejects group account access', async () => {
    const repository = new MemoryRepository();
    const sent: string[] = [];
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }),
      newApi: {
        getStatus: async () => status,
        resolveAccountByTelegramId: async () => account,
        getAccountById: async () => account,
        getUsage: async (_account: NewApiAccount, start: number, end: number) => {
          expect(end - start).toBeGreaterThan(6 * 24 * 60 * 60);
          return { quota: 1000 };
        },
        getSubscriptions: async () => [],
        getNotice: async () => '',
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 7847736904, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push(String((payload as { text?: string }).text ?? ''));
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(2, '/usage 7d') as never);
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 3, date: 1, chat: { id: -9, type: 'group' }, from: { id: 1001, is_bot: false, first_name: 'Alice' }, text: '/account', entities: [{ offset: 0, length: 8, type: 'bot_command' }] },
    } as never);

    expect(sent.some((text) => text.includes('近 7 天用量'))).toBe(true);
    expect(sent.some((text) => text.includes('请在与机器人的私聊中'))).toBe(true);
  });

  it('does not forward credentials or payment credentials through support', async () => {
    const repository = new MemoryRepository();
    const sent: Array<{ chatId: string; text: string }> = [];
    const bot = createBot({
      config: config({ SUPPORT_CHAT_ID: '-99' }), repository, logger: pino({ enabled: false }),
      newApi: {
        getStatus: async () => status,
        resolveAccountByTelegramId: async () => account,
        getAccountById: async () => account,
        getUsage: async () => ({ quota: 1000 }),
        getSubscriptions: async () => [],
        getNotice: async () => '',
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') {
        const input = payload as { chat_id?: string | number; text?: string };
        sent.push({ chatId: String(input.chat_id), text: String(input.text ?? '') });
      }
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(4, '/support api_key=sk-secret-value') as never);

    expect(sent.some((item) => item.chatId === '-99')).toBe(false);
    expect(sent.some((item) => item.text.includes('请勿通过机器人发送'))).toBe(true);
  });
});
