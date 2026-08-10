import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { MemoryRepository, SqliteRepository } from '../../src/db.js';

const binding = {
  telegramUserId: '1001',
  newApiUserId: 42,
  usernameSnapshot: 'alice',
  status: 'active' as const,
  verifiedAt: new Date('2026-08-09T00:00:00.000Z'),
  lastVerifiedAt: new Date('2026-08-09T00:00:00.000Z'),
};

describe('MemoryRepository', () => {
  it('claims each update exactly once', async () => {
    const repository = new MemoryRepository();
    expect(await repository.claimUpdate(7)).toBe(true);
    expect(await repository.claimUpdate(7)).toBe(false);
    await repository.releaseUpdate(7);
    expect(await repository.claimUpdate(7)).toBe(true);
  });

  it('revokes a binding without deleting its audit history', async () => {
    const repository = new MemoryRepository();
    await repository.saveBinding(binding);
    expect(await repository.getBinding('1001')).toEqual(binding);

    await repository.writeAudit({ actorTelegramUserId: '1001', action: 'binding.created' });
    await repository.revokeBinding('1001');

    expect(await repository.getBinding('1001')).toBeNull();
    expect(repository.audits).toHaveLength(1);
  });

  it('deduplicates notification events and routes support replies by operator message', async () => {
    const repository = new MemoryRepository();
    await repository.upsertTelegramUser({
      telegramUserId: '1001', chatId: '1001', username: 'alice', locale: 'zh',
    });
    await repository.saveBinding(binding);

    expect(await repository.claimNotificationEvent('low:42:100', '1001', 'low_quota')).toBe(true);
    expect(await repository.claimNotificationEvent('low:42:100', '1001', 'low_quota')).toBe(false);
    await repository.clearNotificationEvent('low:42:100');
    expect(await repository.claimNotificationEvent('low:42:100', '1001', 'low_quota')).toBe(true);

    const ticket = await repository.createSupportTicket({
      telegramUserId: '1001', chatId: '1001', opsChatId: '-99', opsMessageId: 7,
    });
    expect(await repository.findSupportTicketByOpsMessage('-99', 7)).toMatchObject({
      ticketNo: ticket.ticketNo, status: 'open',
    });
    await repository.closeSupportTicket(ticket.ticketNo);
    expect((await repository.findSupportTicketByOpsMessage('-99', 7))?.status).toBe('closed');
  });
});

describe('SqliteRepository', () => {
  it('persists bindings, notification state, tickets, and audit data', async () => {
    const repository = new SqliteRepository('sqlite::memory:', pino({ enabled: false }));
    await repository.init();
    try {
      await repository.upsertTelegramUser({
        telegramUserId: '1001', chatId: '1001', username: 'alice', locale: 'zh',
      });
      expect(await repository.claimUpdate(7)).toBe(true);
      expect(await repository.claimUpdate(7)).toBe(false);
      await repository.releaseUpdate(7);
      expect(await repository.claimUpdate(7)).toBe(true);

      await repository.saveBinding(binding);
      expect(await repository.getBinding('1001')).toEqual(binding);
      expect(await repository.listActiveBindings()).toHaveLength(1);

      await repository.saveNotificationPreference({
        telegramUserId: '1001', lowQuotaThreshold: 100, subscriptionNoticeDays: 5, paused: true, updatedAt: binding.verifiedAt,
      });
      expect(await repository.getNotificationPreference('1001')).toMatchObject({
        lowQuotaThreshold: 100, subscriptionNoticeDays: 5, paused: true,
      });
      expect(await repository.claimNotificationEvent('low:42:100', '1001', 'low_quota')).toBe(true);
      expect(await repository.claimNotificationEvent('low:42:100', '1001', 'low_quota')).toBe(false);

      const ticket = await repository.createSupportTicket({
        telegramUserId: '1001', chatId: '1001', opsChatId: '-99', opsMessageId: 7,
      });
      await repository.writeAudit({ actorTelegramUserId: '1001', action: 'binding.created' });
      expect(await repository.getStats()).toEqual({ telegramUsers: 1, activeBindings: 1, openTickets: 1 });
      await repository.closeSupportTicket(ticket.ticketNo);
      expect((await repository.findSupportTicketByOpsMessage('-99', 7))?.status).toBe('closed');

      await repository.revokeBinding('1001');
      expect(await repository.getBinding('1001')).toBeNull();
    } finally {
      await repository.close();
    }
  });

  it('reopens a file-backed database without losing the binding or queued broadcast deliveries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'supertoken-bot-'));
    const databaseUrl = `sqlite:${join(directory, 'bot.sqlite')}`;
    const logger = pino({ enabled: false });
    const first = new SqliteRepository(databaseUrl, logger);
    try {
      await first.init();
      await first.upsertTelegramUser({ telegramUserId: '1001', chatId: '1001', locale: 'zh' });
      await first.saveBinding(binding);
      await first.enqueueTelegramUpdate(88, '{"update_id":88}');
      await first.createBroadcastDraft({
        id: 'BC-0123456789AB', adminTelegramUserId: '9001', message: '维护通知',
        recipients: [{ telegramUserId: '1001', chatId: '1001' }],
      });
      await first.queueBroadcast('BC-0123456789AB', '9001');
      await first.close();

      const reopened = new SqliteRepository(databaseUrl, logger);
      await reopened.init();
      try {
        expect(await reopened.getBinding('1001')).toEqual(binding);
        expect(await reopened.claimQueuedTelegramUpdate()).toEqual({
          updateId: 88, payload: '{"update_id":88}', attempts: 1,
        });
        await reopened.completeQueuedTelegramUpdate(88);
        expect(await reopened.claimQueuedTelegramUpdate()).toBeNull();
        expect(await reopened.getBroadcast('BC-0123456789AB', '9001')).toMatchObject({ status: 'queued', targetCount: 1 });
        expect(await reopened.claimBroadcastDelivery()).toMatchObject({
          broadcastId: 'BC-0123456789AB', telegramUserId: '1001', chatId: '1001', attempts: 1,
        });
        await reopened.completeBroadcastDelivery('BC-0123456789AB', '1001');
        expect(await reopened.getBroadcast('BC-0123456789AB', '9001')).toMatchObject({
          status: 'completed', delivered: 1, failed: 0,
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await first.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces pause, resume, and cancel transitions for a SQLite broadcast', async () => {
    const repository = new SqliteRepository('sqlite::memory:', pino({ enabled: false }));
    await repository.init();
    try {
      await repository.createBroadcastDraft({
        id: 'BC-ABCDEF012345', adminTelegramUserId: '9001', message: '维护通知',
        recipients: [{ telegramUserId: '1001', chatId: '1001' }],
      });
      expect((await repository.queueBroadcast('BC-ABCDEF012345', '9001'))?.status).toBe('queued');
      expect((await repository.pauseBroadcast('BC-ABCDEF012345', '9001'))?.status).toBe('paused');
      expect(await repository.claimBroadcastDelivery()).toBeNull();
      expect((await repository.resumeBroadcast('BC-ABCDEF012345', '9001'))?.status).toBe('queued');
      expect((await repository.cancelBroadcast('BC-ABCDEF012345', '9001'))?.status).toBe('cancelled');
      expect(await repository.claimBroadcastDelivery()).toBeNull();
    } finally {
      await repository.close();
    }
  });
});
