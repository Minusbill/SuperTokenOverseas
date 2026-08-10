import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { Bot } from 'grammy';
import { processBroadcastDeliveries } from '../../src/broadcast-worker.js';
import { loadConfig } from '../../src/config.js';
import { MemoryRepository } from '../../src/db.js';

function config() {
  return loadConfig({
    NODE_ENV: 'test', BOT_MODE: 'polling', TELEGRAM_BOT_TOKEN: 'test-token',
    NEW_API_BASE_URL: 'https://new-api.example.test', NEW_API_INTEGRATION_MODE: 'bridge',
    NEW_API_INTEGRATION_SECRET: 'integration-secret-123456', BROADCAST_DELAY_MS: '0',
  });
}

async function queuedBroadcast(repository: MemoryRepository, id = 'BC-0123456789AB') {
  await repository.createBroadcastDraft({
    id,
    adminTelegramUserId: '9001',
    message: '维护通知',
    recipients: [{ telegramUserId: '1001', chatId: '1001' }],
  });
  await repository.queueBroadcast(id, '9001');
  return id;
}

function botWith(sendMessage: (chatId: string, text: string) => Promise<unknown>): Bot {
  return { api: { sendMessage } } as unknown as Bot;
}

describe('broadcast worker', () => {
  it('delivers a queued broadcast and completes its persistent task', async () => {
    const repository = new MemoryRepository();
    const id = await queuedBroadcast(repository);
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = {
      config: config(), repository, logger: pino({ enabled: false }),
      bot: botWith(async (chatId, text) => {
        sent.push({ chatId, text });
        return { message_id: 1 };
      }),
    };

    await expect(processBroadcastDeliveries(deps, { delayMs: 0 })).resolves.toEqual({
      completed: 1, retried: 0, failed: 0, cancelled: 0,
    });
    expect(sent).toEqual([{ chatId: '1001', text: '维护通知' }]);
    expect(await repository.getBroadcast(id, '9001')).toMatchObject({ status: 'completed', delivered: 1, failed: 0 });
  });

  it('retries a failed delivery and later completes it', async () => {
    const repository = new MemoryRepository();
    const id = await queuedBroadcast(repository);
    let attempts = 0;
    const deps = {
      config: config(), repository, logger: pino({ enabled: false }),
      bot: botWith(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary Telegram outage');
        return { message_id: 1 };
      }),
    };

    await expect(processBroadcastDeliveries(deps, { retryDelayMs: 0, delayMs: 0 })).resolves.toEqual({
      completed: 0, retried: 1, failed: 0, cancelled: 0,
    });
    await expect(processBroadcastDeliveries(deps, { retryDelayMs: 0, delayMs: 0 })).resolves.toEqual({
      completed: 1, retried: 0, failed: 0, cancelled: 0,
    });
    expect(await repository.getBroadcast(id, '9001')).toMatchObject({ status: 'completed', delivered: 1, failed: 0 });
  });

  it('marks a delivery as failed after five attempts and audits the terminal failure', async () => {
    const repository = new MemoryRepository();
    const id = await queuedBroadcast(repository);
    const deps = {
      config: config(), repository, logger: pino({ enabled: false }),
      bot: botWith(async () => { throw new Error('Telegram unavailable'); }),
    };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(processBroadcastDeliveries(deps, { retryDelayMs: 0, delayMs: 0 })).resolves.toEqual({
        completed: 0,
        retried: attempt === 5 ? 0 : 1,
        failed: attempt === 5 ? 1 : 0,
        cancelled: 0,
      });
    }
    expect(await repository.getBroadcast(id, '9001')).toMatchObject({ status: 'completed', delivered: 0, failed: 1 });
    expect(repository.audits).toContainEqual(expect.objectContaining({
      action: 'broadcast.delivery_failed', targetType: 'broadcast', targetId: id,
    }));
  });

  it('does not claim paused tasks and resumes them when the administrator continues the broadcast', async () => {
    const repository = new MemoryRepository();
    const id = await queuedBroadcast(repository);
    await repository.pauseBroadcast(id, '9001');
    const deps = {
      config: config(), repository, logger: pino({ enabled: false }),
      bot: botWith(async () => ({ message_id: 1 })),
    };

    await expect(processBroadcastDeliveries(deps, { delayMs: 0 })).resolves.toEqual({
      completed: 0, retried: 0, failed: 0, cancelled: 0,
    });
    await repository.resumeBroadcast(id, '9001');
    await expect(processBroadcastDeliveries(deps, { delayMs: 0 })).resolves.toEqual({
      completed: 1, retried: 0, failed: 0, cancelled: 0,
    });
  });
});
