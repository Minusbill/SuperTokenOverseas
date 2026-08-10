import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot.js';
import { loadConfig } from '../../src/config.js';
import { MemoryRepository } from '../../src/db.js';
import { processQueuedTelegramUpdates } from '../../src/update-worker.js';

function messageUpdate(updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1001, type: 'private' },
      from: { id: 1001, is_bot: false, first_name: 'Alice', language_code: 'zh' },
      text: '/start',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  };
}

describe('Telegram update queue worker', () => {
  it('retries a failed queued update and completes it without duplicating the reply', async () => {
    const repository = new MemoryRepository();
    const originalUpsert = repository.upsertTelegramUser.bind(repository);
    let fail = true;
    repository.upsertTelegramUser = async (user) => {
      if (fail) {
        fail = false;
        throw new Error('temporary database failure');
      }
      return originalUpsert(user);
    };
    const config = loadConfig({
      NODE_ENV: 'test', BOT_MODE: 'webhook', PUBLIC_BASE_URL: 'https://bot.example.test',
      TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-1234567890',
      NEW_API_BASE_URL: 'https://new-api.example.test', NEW_API_INTEGRATION_MODE: 'bridge',
      NEW_API_INTEGRATION_SECRET: 'integration-secret-123456',
    });
    const sent: string[] = [];
    const bot = createBot({ config, repository, newApi: {} as never, logger: pino({ enabled: false }) });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push(String((payload as { text?: string }).text ?? ''));
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();
    await repository.enqueueTelegramUpdate(300, JSON.stringify(messageUpdate(300)));
    const deps = { repository, bot, logger: pino({ enabled: false }) };

    expect(await processQueuedTelegramUpdates(deps, { retryDelayMs: 0 })).toEqual({ completed: 0, retried: 1, failed: 0 });
    expect(await processQueuedTelegramUpdates(deps, { retryDelayMs: 0 })).toEqual({ completed: 1, retried: 0, failed: 0 });
    expect(sent.filter((text) => text.includes('欢迎使用 SuperToken'))).toHaveLength(1);
    expect(await repository.claimQueuedTelegramUpdate()).toBeNull();
  });

  it('marks a permanently failing update as failed after five attempts', async () => {
    const repository = new MemoryRepository();
    await repository.enqueueTelegramUpdate(301, JSON.stringify(messageUpdate(301)));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await repository.claimQueuedTelegramUpdate()).toMatchObject({ updateId: 301, attempts: attempt });
      expect(await repository.retryQueuedTelegramUpdate(301, new Date())).toBe(
        attempt === 5 ? 'failed' : 'queued',
      );
    }
    expect(await repository.claimQueuedTelegramUpdate()).toBeNull();
  });

  it('records an audit event without retaining the failed update payload', async () => {
    const repository = new MemoryRepository();
    await repository.enqueueTelegramUpdate(302, JSON.stringify(messageUpdate(302)));
    const deps = {
      repository,
      bot: { handleUpdate: async () => { throw new Error('unavailable'); } } as never,
      logger: pino({ enabled: false }),
    };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await processQueuedTelegramUpdates(deps, { retryDelayMs: 0 });
      expect(result).toEqual({ completed: 0, retried: attempt === 5 ? 0 : 1, failed: attempt === 5 ? 1 : 0 });
    }

    expect(repository.audits).toContainEqual(expect.objectContaining({
      action: 'telegram_update.failed', targetType: 'telegram_update', targetId: '302',
    }));
    expect(await repository.claimQueuedTelegramUpdate()).toBeNull();
  });
});
