import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { MemoryRepository } from '../../src/db.js';
import { runNotificationCycle } from '../../src/worker.js';
import type { Bot } from 'grammy';
import type { NewApiAccount, NewApiStatus, Subscription } from '../../src/types.js';

const status: NewApiStatus = { quotaPerUnit: 500_000, quotaDisplayType: 'USD' };

function testConfig(): Config {
  return loadConfig({
    NODE_ENV: 'test', BOT_MODE: 'polling', TELEGRAM_BOT_TOKEN: 'test-token',
    NEW_API_BASE_URL: 'https://new-api.example.test', NEW_API_INTEGRATION_MODE: 'bridge',
    NEW_API_INTEGRATION_SECRET: 'integration-secret-123456',
    NOTIFICATION_DEFAULT_LOW_QUOTA_THRESHOLD: '100',
  });
}

describe('notification worker', () => {
  it('sends low-quota and expiry notices once, then rearms after recovery', async () => {
    const repository = new MemoryRepository();
    await repository.upsertTelegramUser({ telegramUserId: '1001', chatId: '1001', locale: 'zh' });
    await repository.saveBinding({
      telegramUserId: '1001', newApiUserId: 42, usernameSnapshot: 'alice', status: 'active',
      verifiedAt: new Date(), lastVerifiedAt: new Date(),
    });
    const messages: string[] = [];
    let account: NewApiAccount = {
      id: 42, username: 'alice', telegramId: '1001', status: 1, quota: 100, usedQuota: 0,
    };
    const expiry: Subscription = { id: 9, status: 'active', endTime: Math.floor(Date.now() / 1000) + 3600 };
    const newApi = {
      getStatus: async () => status,
      resolveAccountByTelegramId: async () => account,
      getSubscriptions: async () => [expiry],
    };
    const bot = { api: { sendMessage: async (_chatId: string, message: string) => {
      messages.push(message);
      return { message_id: messages.length };
    } } } as unknown as Bot;

    await runNotificationCycle({ config: testConfig(), repository, newApi: newApi as never, bot, logger: pino({ enabled: false }) });
    await runNotificationCycle({ config: testConfig(), repository, newApi: newApi as never, bot, logger: pino({ enabled: false }) });
    expect(messages).toHaveLength(2);

    account = { ...account, quota: 1000 };
    await runNotificationCycle({ config: testConfig(), repository, newApi: newApi as never, bot, logger: pino({ enabled: false }) });
    account = { ...account, quota: 100 };
    await runNotificationCycle({ config: testConfig(), repository, newApi: newApi as never, bot, logger: pino({ enabled: false }) });
    expect(messages).toHaveLength(3);
  });
});
