import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { MemoryRepository } from '../../src/db.js';
import { createServer } from '../../src/server.js';

const webhookSecret = 'webhook-secret-1234567890';

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

describe('Telegram webhook server', () => {
  it('rejects an invalid secret without handling the update', async () => {
    const repository = new MemoryRepository();
    const config = loadConfig({
      NODE_ENV: 'test', BOT_MODE: 'webhook', PUBLIC_BASE_URL: 'https://bot.example.test',
      TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      NEW_API_BASE_URL: 'https://new-api.example.test', NEW_API_INTEGRATION_MODE: 'bridge',
      NEW_API_INTEGRATION_SECRET: 'integration-secret-123456',
    });
    const server = createServer({ config, repository, newApi: {} as never });

    const response = await server.inject({
      method: 'POST', url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      payload: messageUpdate(200),
    });

    expect(response.statusCode).toBe(401);
    expect(await repository.claimQueuedTelegramUpdate()).toBeNull();
    await server.close();
  });

  it('persists a valid update once and responds before any Bot handler runs', async () => {
    const repository = new MemoryRepository();
    const config = loadConfig({
      NODE_ENV: 'test', BOT_MODE: 'webhook', PUBLIC_BASE_URL: 'https://bot.example.test',
      TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      NEW_API_BASE_URL: 'https://new-api.example.test', NEW_API_INTEGRATION_MODE: 'bridge',
      NEW_API_INTEGRATION_SECRET: 'integration-secret-123456',
    });
    let wakeCount = 0;
    const server = createServer({
      config, repository, newApi: {} as never, onTelegramUpdateQueued: () => { wakeCount += 1; },
    });
    const request = {
      method: 'POST' as const,
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: messageUpdate(201),
    };

    const first = await server.inject(request);
    const duplicate = await server.inject(request);
    const queued = await repository.claimQueuedTelegramUpdate();

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(wakeCount).toBe(1);
    expect(queued).toMatchObject({ updateId: 201, attempts: 1 });
    expect(JSON.parse(queued?.payload ?? '{}')).toMatchObject({ update_id: 201 });
    await server.close();
  });

  it('rejects a malformed update without queueing it', async () => {
    const repository = new MemoryRepository();
    const config = loadConfig({
      NODE_ENV: 'test', BOT_MODE: 'webhook', PUBLIC_BASE_URL: 'https://bot.example.test',
      TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      NEW_API_BASE_URL: 'https://new-api.example.test', NEW_API_INTEGRATION_MODE: 'bridge',
      NEW_API_INTEGRATION_SECRET: 'integration-secret-123456',
    });
    const server = createServer({ config, repository, newApi: {} as never });

    const response = await server.inject({
      method: 'POST', url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      payload: { update_id: 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(await repository.claimQueuedTelegramUpdate()).toBeNull();
    await server.close();
  });
});
