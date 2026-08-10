import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient } from 'pg';
import type { Logger } from 'pino';
import type {
  AccountBinding,
  ActiveBinding,
  BotAuditMetadata,
  BotRepository,
  Broadcast,
  BroadcastRecipient,
  NotificationPreference,
  QueuedBroadcastDelivery,
  QueuedTelegramUpdate,
  RepositoryStats,
  SupportTicket,
  TelegramUser,
} from './types.js';

const postgresSchemaUrl = new URL('../migrations/001_init.sql', import.meta.url);
const sqliteSchemaUrl = new URL('../migrations/001_init.sqlite.sql', import.meta.url);
const require = createRequire(import.meta.url);

export class PostgresRepository implements BotRepository {
  private readonly pool: Pool;

  public constructor(databaseUrl: string, private readonly logger: Logger) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  public async init(): Promise<void> {
    const schema = await readFile(fileURLToPath(postgresSchemaUrl), 'utf8');
    await this.pool.query(schema);
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async claimUpdate(updateId: number): Promise<boolean> {
    const result = await this.pool.query(
      'INSERT INTO processed_updates (update_id) VALUES ($1) ON CONFLICT (update_id) DO NOTHING',
      [updateId],
    );
    return result.rowCount === 1;
  }

  public async releaseUpdate(updateId: number): Promise<void> {
    await this.pool.query('DELETE FROM processed_updates WHERE update_id = $1', [updateId]);
  }

  public async enqueueTelegramUpdate(updateId: number, payload: string): Promise<boolean> {
    const now = new Date();
    const result = await this.pool.query(
      `INSERT INTO telegram_update_queue (update_id, payload, available_at, created_at, updated_at)
       VALUES ($1, $2, $3, $3, $3)
       ON CONFLICT (update_id) DO NOTHING`,
      [updateId, payload, now],
    );
    return result.rowCount === 1;
  }

  public async claimQueuedTelegramUpdate(): Promise<QueuedTelegramUpdate | null> {
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT update_id
         FROM telegram_update_queue
         WHERE (status = 'queued' AND available_at <= NOW())
            OR (status = 'processing' AND lease_expires_at <= NOW())
         ORDER BY available_at, update_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE telegram_update_queue AS queue
       SET status = 'processing',
           attempts = queue.attempts + 1,
           lease_expires_at = NOW() + INTERVAL '60 seconds',
           updated_at = NOW()
       FROM candidate
       WHERE queue.update_id = candidate.update_id
       RETURNING queue.update_id, queue.payload, queue.attempts`,
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapQueuedTelegramUpdate(row) : null;
  }

  public async completeQueuedTelegramUpdate(updateId: number): Promise<void> {
    await this.pool.query(
      `UPDATE telegram_update_queue
       SET status = 'completed', payload = NULL, lease_expires_at = NULL,
           completed_at = NOW(), updated_at = NOW()
       WHERE update_id = $1`,
      [updateId],
    );
  }

  public async retryQueuedTelegramUpdate(
    updateId: number,
    retryAt: Date,
  ): Promise<'queued' | 'failed'> {
    const result = await this.pool.query(
      `UPDATE telegram_update_queue
       SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
           available_at = CASE WHEN attempts >= 5 THEN available_at ELSE $2 END,
           payload = CASE WHEN attempts >= 5 THEN NULL ELSE payload END,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE update_id = $1
       RETURNING status`,
      [updateId, retryAt],
    );
    return result.rows[0]?.status === 'failed' ? 'failed' : 'queued';
  }

  public async createBroadcastDraft(input: {
    id: string;
    adminTelegramUserId: string;
    message: string;
    recipients: BroadcastRecipient[];
  }): Promise<Broadcast> {
    const recipients = uniqueBroadcastRecipients(input.recipients);
    const now = new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO broadcasts
           (id, admin_telegram_user_id, message, status, target_count, created_at, updated_at)
         VALUES ($1, $2, $3, 'draft', $4, $5, $5)
         RETURNING id, admin_telegram_user_id, message, status, target_count, delivered_count,
                   failed_count, created_at, updated_at, completed_at`,
        [input.id, input.adminTelegramUserId, input.message, recipients.length, now],
      );
      if (recipients.length > 0) {
        await client.query(
          `INSERT INTO broadcast_deliveries
             (broadcast_id, telegram_user_id, chat_id, status, attempts, available_at, updated_at)
           SELECT $1, recipient.telegram_user_id, recipient.chat_id, 'queued', 0, $4, $4
           FROM UNNEST($2::text[], $3::text[]) AS recipient(telegram_user_id, chat_id)`,
          [input.id, recipients.map((recipient) => recipient.telegramUserId), recipients.map((recipient) => recipient.chatId), now],
        );
      }
      await client.query('COMMIT');
      return mapBroadcast(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async getBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    const result = await this.pool.query(
      `SELECT id, admin_telegram_user_id, message, status, target_count, delivered_count,
              failed_count, created_at, updated_at, completed_at
       FROM broadcasts WHERE id = $1 AND admin_telegram_user_id = $2`,
      [broadcastId, adminTelegramUserId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapBroadcast(row) : null;
  }

  public async queueBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    const result = await this.pool.query(
      `UPDATE broadcasts
       SET status = CASE WHEN target_count = 0 THEN 'completed' ELSE 'queued' END,
           updated_at = NOW(),
           completed_at = CASE WHEN target_count = 0 THEN NOW() ELSE NULL END
       WHERE id = $1 AND admin_telegram_user_id = $2 AND status = 'draft'
       RETURNING id, admin_telegram_user_id, message, status, target_count, delivered_count,
                 failed_count, created_at, updated_at, completed_at`,
      [broadcastId, adminTelegramUserId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapBroadcast(row) : null;
  }

  public async pauseBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    return this.updateBroadcastStatus(broadcastId, adminTelegramUserId, ['queued', 'running'], 'paused');
  }

  public async resumeBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    return this.updateBroadcastStatus(broadcastId, adminTelegramUserId, ['paused'], 'queued');
  }

  public async cancelBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE broadcasts
         SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1 AND admin_telegram_user_id = $2
           AND status IN ('draft', 'queued', 'running', 'paused')
         RETURNING id, admin_telegram_user_id, message, status, target_count, delivered_count,
                   failed_count, created_at, updated_at, completed_at`,
        [broadcastId, adminTelegramUserId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        `UPDATE broadcast_deliveries
         SET status = 'cancelled', lease_expires_at = NULL, updated_at = NOW()
         WHERE broadcast_id = $1 AND status = 'queued'`,
        [broadcastId],
      );
      await client.query('COMMIT');
      return mapBroadcast(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimBroadcastDelivery(): Promise<QueuedBroadcastDelivery | null> {
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT delivery.broadcast_id, delivery.telegram_user_id
         FROM broadcast_deliveries AS delivery
         JOIN broadcasts AS broadcast ON broadcast.id = delivery.broadcast_id
         WHERE broadcast.status IN ('queued', 'running')
           AND ((delivery.status = 'queued' AND delivery.available_at <= NOW())
             OR (delivery.status = 'processing' AND delivery.lease_expires_at <= NOW()))
         ORDER BY broadcast.created_at, delivery.available_at, delivery.telegram_user_id
         FOR UPDATE OF delivery, broadcast SKIP LOCKED
         LIMIT 1
       ), claimed AS (
         UPDATE broadcast_deliveries AS delivery
         SET status = 'processing', attempts = delivery.attempts + 1,
             lease_expires_at = NOW() + INTERVAL '60 seconds', updated_at = NOW()
         FROM candidate
         WHERE delivery.broadcast_id = candidate.broadcast_id
           AND delivery.telegram_user_id = candidate.telegram_user_id
         RETURNING delivery.broadcast_id, delivery.telegram_user_id, delivery.chat_id, delivery.attempts
       ), running AS (
         UPDATE broadcasts AS broadcast
         SET status = 'running', updated_at = NOW()
         FROM claimed
         WHERE broadcast.id = claimed.broadcast_id AND broadcast.status = 'queued'
       )
       SELECT claimed.broadcast_id, claimed.telegram_user_id, claimed.chat_id, claimed.attempts, broadcast.message
       FROM claimed JOIN broadcasts AS broadcast ON broadcast.id = claimed.broadcast_id`,
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapQueuedBroadcastDelivery(row) : null;
  }

  public async completeBroadcastDelivery(broadcastId: string, telegramUserId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE broadcast_deliveries
         SET status = 'delivered', lease_expires_at = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE broadcast_id = $1 AND telegram_user_id = $2 AND status = 'processing'`,
        [broadcastId, telegramUserId],
      );
      await refreshPostgresBroadcast(client, broadcastId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async retryBroadcastDelivery(
    broadcastId: string,
    telegramUserId: string,
    retryAt: Date,
  ): Promise<'queued' | 'failed' | 'cancelled'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT delivery.attempts, broadcast.status
         FROM broadcast_deliveries AS delivery
         JOIN broadcasts AS broadcast ON broadcast.id = delivery.broadcast_id
         WHERE delivery.broadcast_id = $1 AND delivery.telegram_user_id = $2
         FOR UPDATE`,
        [broadcastId, telegramUserId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row || row.status === 'cancelled') {
        await client.query(
          `UPDATE broadcast_deliveries
           SET status = 'cancelled', lease_expires_at = NULL, updated_at = NOW()
           WHERE broadcast_id = $1 AND telegram_user_id = $2 AND status = 'processing'`,
          [broadcastId, telegramUserId],
        );
        await client.query('COMMIT');
        return 'cancelled';
      }
      const failed = Number(row.attempts) >= 5;
      await client.query(
        `UPDATE broadcast_deliveries
         SET status = $3, available_at = CASE WHEN $4 THEN available_at ELSE $5 END,
             lease_expires_at = NULL, completed_at = CASE WHEN $4 THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE broadcast_id = $1 AND telegram_user_id = $2 AND status = 'processing'`,
        [broadcastId, telegramUserId, failed ? 'failed' : 'queued', failed, retryAt],
      );
      await refreshPostgresBroadcast(client, broadcastId);
      await client.query('COMMIT');
      return failed ? 'failed' : 'queued';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async upsertTelegramUser(user: TelegramUser): Promise<TelegramUser> {
    const result = await this.pool.query(
      `INSERT INTO telegram_users (telegram_user_id, chat_id, username, display_name, locale)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         chat_id = EXCLUDED.chat_id,
         username = EXCLUDED.username,
         display_name = EXCLUDED.display_name,
         updated_at = NOW()
       RETURNING telegram_user_id, chat_id, username, display_name, locale`,
      [user.telegramUserId, user.chatId, user.username ?? null, user.displayName ?? null, user.locale],
    );
    return mapTelegramUser(result.rows[0] as Record<string, unknown>);
  }

  public async setTelegramUserLocale(telegramUserId: string, locale: TelegramUser['locale']): Promise<void> {
    await this.pool.query(
      'UPDATE telegram_users SET locale = $1, updated_at = NOW() WHERE telegram_user_id = $2',
      [locale, telegramUserId],
    );
  }

  public async getBinding(telegramUserId: string): Promise<AccountBinding | null> {
    const result = await this.pool.query(
      `SELECT telegram_user_id, new_api_user_id, username_snapshot, status,
              verified_at, last_verified_at
       FROM account_bindings
       WHERE telegram_user_id = $1 AND status = 'active'`,
      [telegramUserId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapBinding(row) : null;
  }

  public async saveBinding(binding: AccountBinding): Promise<void> {
    await this.pool.query(
      `INSERT INTO account_bindings
         (telegram_user_id, new_api_user_id, username_snapshot, status, verified_at, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         new_api_user_id = EXCLUDED.new_api_user_id,
         username_snapshot = EXCLUDED.username_snapshot,
         status = EXCLUDED.status,
         verified_at = EXCLUDED.verified_at,
         last_verified_at = EXCLUDED.last_verified_at,
         updated_at = NOW()`,
      [
        binding.telegramUserId,
        binding.newApiUserId,
        binding.usernameSnapshot,
        binding.status,
        binding.verifiedAt,
        binding.lastVerifiedAt,
      ],
    );
  }

  public async revokeBinding(telegramUserId: string): Promise<void> {
    await this.pool.query(
      "UPDATE account_bindings SET status = 'revoked', updated_at = NOW() WHERE telegram_user_id = $1",
      [telegramUserId],
    );
  }

  public async getNotificationPreference(telegramUserId: string): Promise<NotificationPreference> {
    const result = await this.pool.query(
      `SELECT telegram_user_id, low_quota_threshold, subscription_notice_days, paused, updated_at
       FROM notification_preferences WHERE telegram_user_id = $1`,
      [telegramUserId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return {
        telegramUserId,
        subscriptionNoticeDays: 3,
        paused: false,
        updatedAt: new Date(),
      };
    }
    const threshold = row.low_quota_threshold === null || row.low_quota_threshold === undefined
      ? undefined
      : Number(row.low_quota_threshold);
    return {
      telegramUserId: String(row.telegram_user_id),
      ...(threshold !== undefined ? { lowQuotaThreshold: threshold } : {}),
      subscriptionNoticeDays: Number(row.subscription_notice_days),
      paused: Boolean(row.paused),
      updatedAt: new Date(String(row.updated_at)),
    };
  }

  public async saveNotificationPreference(preference: NotificationPreference): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_preferences
         (telegram_user_id, low_quota_threshold, subscription_notice_days, paused)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         low_quota_threshold = EXCLUDED.low_quota_threshold,
         subscription_notice_days = EXCLUDED.subscription_notice_days,
         paused = EXCLUDED.paused,
         updated_at = NOW()`,
      [
        preference.telegramUserId,
        preference.lowQuotaThreshold ?? null,
        preference.subscriptionNoticeDays,
        preference.paused,
      ],
    );
  }

  public async claimNotificationEvent(eventKey: string, telegramUserId: string, kind: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO notification_events (event_key, telegram_user_id, kind)
       VALUES ($1, $2, $3) ON CONFLICT (event_key) DO NOTHING`,
      [eventKey, telegramUserId, kind],
    );
    return result.rowCount === 1;
  }

  public async clearNotificationEvent(eventKey: string): Promise<void> {
    await this.pool.query('DELETE FROM notification_events WHERE event_key = $1', [eventKey]);
  }

  public async listActiveBindings(): Promise<ActiveBinding[]> {
    const result = await this.pool.query(
      `SELECT tu.telegram_user_id, tu.chat_id, tu.username, tu.display_name, tu.locale,
              ab.new_api_user_id, ab.username_snapshot, ab.status, ab.verified_at, ab.last_verified_at
       FROM account_bindings ab
       JOIN telegram_users tu ON tu.telegram_user_id = ab.telegram_user_id
       WHERE ab.status = 'active' AND tu.status = 'active'
       ORDER BY ab.telegram_user_id`,
    );
    return result.rows.map((row) => {
      const item = row as Record<string, unknown>;
      const username = item.username === null || item.username === undefined ? undefined : String(item.username);
      const displayName = item.display_name === null || item.display_name === undefined
        ? undefined
        : String(item.display_name);
      const user: TelegramUser = {
        telegramUserId: String(item.telegram_user_id),
        chatId: String(item.chat_id),
        ...(username ? { username } : {}),
        ...(displayName ? { displayName } : {}),
        locale: item.locale === 'en' ? 'en' : 'zh',
      };
      return { user, binding: mapBinding(item) };
    });
  }

  public async createSupportTicket(input: {
    telegramUserId: string;
    chatId: string;
    opsChatId: string;
    opsMessageId: number;
  }): Promise<SupportTicket> {
    const ticketNo = `ST-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    const result = await this.pool.query(
      `INSERT INTO support_tickets
         (ticket_no, telegram_user_id, chat_id, ops_chat_id, ops_message_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, ticket_no, telegram_user_id, chat_id, ops_chat_id, ops_message_id, status, created_at, closed_at`,
      [ticketNo, input.telegramUserId, input.chatId, input.opsChatId, input.opsMessageId],
    );
    const row = result.rows[0] as Record<string, unknown>;
    return mapSupportTicket(row);
  }

  public async findSupportTicketByOpsMessage(opsChatId: string, opsMessageId: number): Promise<SupportTicket | null> {
    const result = await this.pool.query(
      `SELECT id, ticket_no, telegram_user_id, chat_id, ops_chat_id, ops_message_id,
              status, created_at, closed_at
       FROM support_tickets WHERE ops_chat_id = $1 AND ops_message_id = $2`,
      [opsChatId, opsMessageId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapSupportTicket(row) : null;
  }

  public async closeSupportTicket(ticketNo: string): Promise<void> {
    await this.pool.query(
      "UPDATE support_tickets SET status = 'closed', closed_at = NOW() WHERE ticket_no = $1 AND status = 'open'",
      [ticketNo],
    );
  }

  public async getStats(): Promise<RepositoryStats> {
    const [users, bindings, tickets] = await Promise.all([
      this.pool.query("SELECT COUNT(*)::bigint AS count FROM telegram_users WHERE status = 'active'"),
      this.pool.query("SELECT COUNT(*)::bigint AS count FROM account_bindings WHERE status = 'active'"),
      this.pool.query("SELECT COUNT(*)::bigint AS count FROM support_tickets WHERE status = 'open'"),
    ]);
    return {
      telegramUsers: Number(users.rows[0]?.count ?? 0),
      activeBindings: Number(bindings.rows[0]?.count ?? 0),
      openTickets: Number(tickets.rows[0]?.count ?? 0),
    };
  }

  public async writeAudit(input: {
    actorTelegramUserId?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: BotAuditMetadata;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (actor_telegram_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.actorTelegramUserId ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(normalizeAuditMetadata(input.metadata)),
      ],
    );
  }

  private async updateBroadcastStatus(
    broadcastId: string,
    adminTelegramUserId: string,
    from: Broadcast['status'][],
    to: Broadcast['status'],
  ): Promise<Broadcast | null> {
    const result = await this.pool.query(
      `UPDATE broadcasts
       SET status = $3, updated_at = NOW()
       WHERE id = $1 AND admin_telegram_user_id = $2 AND status = ANY($4::text[])
       RETURNING id, admin_telegram_user_id, message, status, target_count, delivered_count,
                 failed_count, created_at, updated_at, completed_at`,
      [broadcastId, adminTelegramUserId, to, from],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapBroadcast(row) : null;
  }
}

async function refreshPostgresBroadcast(client: PoolClient, broadcastId: string): Promise<void> {
  await client.query(
    `UPDATE broadcasts AS broadcast
     SET delivered_count = counts.delivered_count,
         failed_count = counts.failed_count,
         updated_at = NOW(),
         status = CASE
           WHEN broadcast.status IN ('queued', 'running') AND counts.remaining_count = 0 THEN 'completed'
           ELSE broadcast.status
         END,
         completed_at = CASE
           WHEN broadcast.status IN ('queued', 'running') AND counts.remaining_count = 0 THEN NOW()
           ELSE broadcast.completed_at
         END
     FROM (
       SELECT
         COUNT(*) FILTER (WHERE status = 'delivered')::integer AS delivered_count,
         COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
         COUNT(*) FILTER (WHERE status IN ('queued', 'processing'))::integer AS remaining_count
       FROM broadcast_deliveries WHERE broadcast_id = $1
     ) AS counts
     WHERE broadcast.id = $1`,
    [broadcastId],
  );
}

type SqliteRow = Record<string, unknown>;

/**
 * SQLite is intentionally kept single-process. WAL makes concurrent reads safe,
 * while one Bot process owns writes during the early deployment stage.
 */
export class SqliteRepository implements BotRepository {
  private database: DatabaseSync | undefined;
  private readonly databasePath: string;

  public constructor(databaseUrl: string, private readonly logger: Logger) {
    this.databasePath = resolveSqliteDatabasePath(databaseUrl);
  }

  public async init(): Promise<void> {
    if (this.databasePath !== ':memory:') await mkdir(dirname(this.databasePath), { recursive: true });
    const { DatabaseSync: SqliteDatabase } = require('node:sqlite') as typeof import('node:sqlite');
    this.database = new SqliteDatabase(this.databasePath);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const schema = await readFile(fileURLToPath(sqliteSchemaUrl), 'utf8');
    this.database.exec(schema);
    this.logger.info({ storage: 'sqlite' }, 'repository initialized');
  }

  public async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
  }

  public async claimUpdate(updateId: number): Promise<boolean> {
    const result = this.db.prepare(
      'INSERT INTO processed_updates (update_id) VALUES (?) ON CONFLICT (update_id) DO NOTHING',
    ).run(updateId);
    return Number(result.changes) === 1;
  }

  public async releaseUpdate(updateId: number): Promise<void> {
    this.db.prepare('DELETE FROM processed_updates WHERE update_id = ?').run(updateId);
  }

  public async enqueueTelegramUpdate(updateId: number, payload: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO telegram_update_queue (update_id, payload, available_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (update_id) DO NOTHING`,
    ).run(updateId, payload, now, now, now);
    return Number(result.changes) === 1;
  }

  public async claimQueuedTelegramUpdate(): Promise<QueuedTelegramUpdate | null> {
    const now = new Date();
    const nowText = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        `SELECT update_id, payload, attempts
         FROM telegram_update_queue
         WHERE (status = 'queued' AND available_at <= ?)
            OR (status = 'processing' AND lease_expires_at <= ?)
         ORDER BY available_at, update_id
         LIMIT 1`,
      ).get(nowText, nowText) as SqliteRow | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(
        `UPDATE telegram_update_queue
         SET status = 'processing', attempts = attempts + 1,
             lease_expires_at = ?, updated_at = ?
         WHERE update_id = ?`,
      ).run(leaseExpiresAt, nowText, Number(row.update_id));
      this.db.exec('COMMIT');
      return {
        updateId: Number(row.update_id),
        payload: String(row.payload),
        attempts: Number(row.attempts) + 1,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public async completeQueuedTelegramUpdate(updateId: number): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE telegram_update_queue
       SET status = 'completed', payload = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?
       WHERE update_id = ?`,
    ).run(now, now, updateId);
  }

  public async retryQueuedTelegramUpdate(
    updateId: number,
    retryAt: Date,
  ): Promise<'queued' | 'failed'> {
    const row = this.db.prepare(
      `SELECT attempts FROM telegram_update_queue WHERE update_id = ?`,
    ).get(updateId) as SqliteRow | undefined;
    const failed = Number(row?.attempts ?? 0) >= 5;
    this.db.prepare(
      `UPDATE telegram_update_queue
       SET status = ?, available_at = CASE WHEN ? THEN available_at ELSE ? END,
           payload = CASE WHEN ? THEN NULL ELSE payload END,
           lease_expires_at = NULL, updated_at = ?
       WHERE update_id = ?`,
    ).run(
      failed ? 'failed' : 'queued',
      failed ? 1 : 0,
      retryAt.toISOString(),
      failed ? 1 : 0,
      new Date().toISOString(),
      updateId,
    );
    return failed ? 'failed' : 'queued';
  }

  public async createBroadcastDraft(input: {
    id: string;
    adminTelegramUserId: string;
    message: string;
    recipients: BroadcastRecipient[];
  }): Promise<Broadcast> {
    const recipients = uniqueBroadcastRecipients(input.recipients);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        `INSERT INTO broadcasts
           (id, admin_telegram_user_id, message, status, target_count, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
      ).run(input.id, input.adminTelegramUserId, input.message, recipients.length, now, now);
      const insertDelivery = this.db.prepare(
        `INSERT INTO broadcast_deliveries
           (broadcast_id, telegram_user_id, chat_id, status, attempts, available_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
      );
      for (const recipient of recipients) {
        insertDelivery.run(input.id, recipient.telegramUserId, recipient.chatId, now, now);
      }
      const row = this.db.prepare(
        `SELECT id, admin_telegram_user_id, message, status, target_count, delivered_count,
                failed_count, created_at, updated_at, completed_at
         FROM broadcasts WHERE id = ?`,
      ).get(input.id) as SqliteRow | undefined;
      this.db.exec('COMMIT');
      if (!row) throw new Error('SQLite broadcast draft was not persisted');
      return mapBroadcast(row);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public async getBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    const row = this.db.prepare(
      `SELECT id, admin_telegram_user_id, message, status, target_count, delivered_count,
              failed_count, created_at, updated_at, completed_at
       FROM broadcasts WHERE id = ? AND admin_telegram_user_id = ?`,
    ).get(broadcastId, adminTelegramUserId) as SqliteRow | undefined;
    return row ? mapBroadcast(row) : null;
  }

  public async queueBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE broadcasts
       SET status = CASE WHEN target_count = 0 THEN 'completed' ELSE 'queued' END,
           updated_at = ?, completed_at = CASE WHEN target_count = 0 THEN ? ELSE NULL END
       WHERE id = ? AND admin_telegram_user_id = ? AND status = 'draft'`,
    ).run(now, now, broadcastId, adminTelegramUserId);
    if (Number(result.changes) !== 1) return null;
    return this.getBroadcast(broadcastId, adminTelegramUserId);
  }

  public async pauseBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    return this.updateBroadcastStatus(broadcastId, adminTelegramUserId, ['queued', 'running'], 'paused');
  }

  public async resumeBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    return this.updateBroadcastStatus(broadcastId, adminTelegramUserId, ['paused'], 'queued');
  }

  public async cancelBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(
        `UPDATE broadcasts
         SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND admin_telegram_user_id = ?
           AND status IN ('draft', 'queued', 'running', 'paused')`,
      ).run(now, broadcastId, adminTelegramUserId);
      if (Number(result.changes) !== 1) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(
        `UPDATE broadcast_deliveries
         SET status = 'cancelled', lease_expires_at = NULL, updated_at = ?
         WHERE broadcast_id = ? AND status = 'queued'`,
      ).run(now, broadcastId);
      const row = this.db.prepare(
        `SELECT id, admin_telegram_user_id, message, status, target_count, delivered_count,
                failed_count, created_at, updated_at, completed_at
         FROM broadcasts WHERE id = ?`,
      ).get(broadcastId) as SqliteRow | undefined;
      this.db.exec('COMMIT');
      return row ? mapBroadcast(row) : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public async claimBroadcastDelivery(): Promise<QueuedBroadcastDelivery | null> {
    const now = new Date();
    const nowText = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        `SELECT delivery.broadcast_id, delivery.telegram_user_id, delivery.chat_id,
                delivery.attempts, broadcast.message
         FROM broadcast_deliveries AS delivery
         JOIN broadcasts AS broadcast ON broadcast.id = delivery.broadcast_id
         WHERE broadcast.status IN ('queued', 'running')
           AND ((delivery.status = 'queued' AND delivery.available_at <= ?)
             OR (delivery.status = 'processing' AND delivery.lease_expires_at <= ?))
         ORDER BY broadcast.created_at, delivery.available_at, delivery.telegram_user_id
         LIMIT 1`,
      ).get(nowText, nowText) as SqliteRow | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(
        `UPDATE broadcast_deliveries
         SET status = 'processing', attempts = attempts + 1,
             lease_expires_at = ?, updated_at = ?
         WHERE broadcast_id = ? AND telegram_user_id = ?`,
      ).run(leaseExpiresAt, nowText, String(row.broadcast_id), String(row.telegram_user_id));
      this.db.prepare(
        `UPDATE broadcasts SET status = 'running', updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).run(nowText, String(row.broadcast_id));
      this.db.exec('COMMIT');
      return {
        broadcastId: String(row.broadcast_id),
        telegramUserId: String(row.telegram_user_id),
        chatId: String(row.chat_id),
        message: String(row.message),
        attempts: Number(row.attempts) + 1,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public async completeBroadcastDelivery(broadcastId: string, telegramUserId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        `UPDATE broadcast_deliveries
         SET status = 'delivered', lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE broadcast_id = ? AND telegram_user_id = ? AND status = 'processing'`,
      ).run(now, now, broadcastId, telegramUserId);
      this.refreshBroadcast(broadcastId, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public async retryBroadcastDelivery(
    broadcastId: string,
    telegramUserId: string,
    retryAt: Date,
  ): Promise<'queued' | 'failed' | 'cancelled'> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        `SELECT delivery.attempts, broadcast.status
         FROM broadcast_deliveries AS delivery
         JOIN broadcasts AS broadcast ON broadcast.id = delivery.broadcast_id
         WHERE delivery.broadcast_id = ? AND delivery.telegram_user_id = ?`,
      ).get(broadcastId, telegramUserId) as SqliteRow | undefined;
      if (!row || row.status === 'cancelled') {
        this.db.prepare(
          `UPDATE broadcast_deliveries
           SET status = 'cancelled', lease_expires_at = NULL, updated_at = ?
           WHERE broadcast_id = ? AND telegram_user_id = ? AND status = 'processing'`,
        ).run(now, broadcastId, telegramUserId);
        this.db.exec('COMMIT');
        return 'cancelled';
      }
      const failed = Number(row.attempts) >= 5;
      this.db.prepare(
        `UPDATE broadcast_deliveries
         SET status = ?, available_at = CASE WHEN ? THEN available_at ELSE ? END,
             lease_expires_at = NULL, completed_at = CASE WHEN ? THEN ? ELSE NULL END,
             updated_at = ?
         WHERE broadcast_id = ? AND telegram_user_id = ? AND status = 'processing'`,
      ).run(
        failed ? 'failed' : 'queued', failed ? 1 : 0, retryAt.toISOString(), failed ? 1 : 0,
        now, now, broadcastId, telegramUserId,
      );
      this.refreshBroadcast(broadcastId, now);
      this.db.exec('COMMIT');
      return failed ? 'failed' : 'queued';
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public async upsertTelegramUser(user: TelegramUser): Promise<TelegramUser> {
    this.db.prepare(
      `INSERT INTO telegram_users (telegram_user_id, chat_id, username, display_name, locale, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         chat_id = excluded.chat_id,
         username = excluded.username,
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`,
    ).run(
      user.telegramUserId,
      user.chatId,
      user.username ?? null,
      user.displayName ?? null,
      user.locale,
      new Date().toISOString(),
    );
    const row = this.db.prepare(
      `SELECT telegram_user_id, chat_id, username, display_name, locale
       FROM telegram_users WHERE telegram_user_id = ?`,
    ).get(user.telegramUserId) as SqliteRow | undefined;
    if (!row) throw new Error('SQLite Telegram user was not persisted');
    return mapTelegramUser(row);
  }

  public async setTelegramUserLocale(telegramUserId: string, locale: TelegramUser['locale']): Promise<void> {
    this.db.prepare(
      'UPDATE telegram_users SET locale = ?, updated_at = ? WHERE telegram_user_id = ?',
    ).run(locale, new Date().toISOString(), telegramUserId);
  }

  public async getBinding(telegramUserId: string): Promise<AccountBinding | null> {
    const row = this.db.prepare(
      `SELECT telegram_user_id, new_api_user_id, username_snapshot, status,
              verified_at, last_verified_at
       FROM account_bindings
       WHERE telegram_user_id = ? AND status = 'active'`,
    ).get(telegramUserId) as SqliteRow | undefined;
    return row ? mapBinding(row) : null;
  }

  public async saveBinding(binding: AccountBinding): Promise<void> {
    this.db.prepare(
      `INSERT INTO account_bindings
         (telegram_user_id, new_api_user_id, username_snapshot, status, verified_at, last_verified_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         new_api_user_id = excluded.new_api_user_id,
         username_snapshot = excluded.username_snapshot,
         status = excluded.status,
         verified_at = excluded.verified_at,
         last_verified_at = excluded.last_verified_at,
         updated_at = excluded.updated_at`,
    ).run(
      binding.telegramUserId,
      binding.newApiUserId,
      binding.usernameSnapshot,
      binding.status,
      binding.verifiedAt.toISOString(),
      binding.lastVerifiedAt.toISOString(),
      new Date().toISOString(),
    );
  }

  public async revokeBinding(telegramUserId: string): Promise<void> {
    this.db.prepare(
      "UPDATE account_bindings SET status = 'revoked', updated_at = ? WHERE telegram_user_id = ?",
    ).run(new Date().toISOString(), telegramUserId);
  }

  public async getNotificationPreference(telegramUserId: string): Promise<NotificationPreference> {
    const row = this.db.prepare(
      `SELECT telegram_user_id, low_quota_threshold, subscription_notice_days, paused, updated_at
       FROM notification_preferences WHERE telegram_user_id = ?`,
    ).get(telegramUserId) as SqliteRow | undefined;
    if (!row) {
      return {
        telegramUserId,
        subscriptionNoticeDays: 3,
        paused: false,
        updatedAt: new Date(),
      };
    }
    const threshold = row.low_quota_threshold === null || row.low_quota_threshold === undefined
      ? undefined
      : Number(row.low_quota_threshold);
    return {
      telegramUserId: String(row.telegram_user_id),
      ...(threshold !== undefined ? { lowQuotaThreshold: threshold } : {}),
      subscriptionNoticeDays: Number(row.subscription_notice_days),
      paused: Number(row.paused) === 1,
      updatedAt: parseDatabaseDate(row.updated_at),
    };
  }

  public async saveNotificationPreference(preference: NotificationPreference): Promise<void> {
    this.db.prepare(
      `INSERT INTO notification_preferences
         (telegram_user_id, low_quota_threshold, subscription_notice_days, paused, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         low_quota_threshold = excluded.low_quota_threshold,
         subscription_notice_days = excluded.subscription_notice_days,
         paused = excluded.paused,
         updated_at = excluded.updated_at`,
    ).run(
      preference.telegramUserId,
      preference.lowQuotaThreshold ?? null,
      preference.subscriptionNoticeDays,
      preference.paused ? 1 : 0,
      preference.updatedAt.toISOString(),
    );
  }

  public async claimNotificationEvent(eventKey: string, telegramUserId: string, kind: string): Promise<boolean> {
    const result = this.db.prepare(
      `INSERT INTO notification_events (event_key, telegram_user_id, kind)
       VALUES (?, ?, ?) ON CONFLICT (event_key) DO NOTHING`,
    ).run(eventKey, telegramUserId, kind);
    return Number(result.changes) === 1;
  }

  public async clearNotificationEvent(eventKey: string): Promise<void> {
    this.db.prepare('DELETE FROM notification_events WHERE event_key = ?').run(eventKey);
  }

  public async listActiveBindings(): Promise<ActiveBinding[]> {
    const rows = this.db.prepare(
      `SELECT tu.telegram_user_id, tu.chat_id, tu.username, tu.display_name, tu.locale,
              ab.new_api_user_id, ab.username_snapshot, ab.status, ab.verified_at, ab.last_verified_at
       FROM account_bindings ab
       JOIN telegram_users tu ON tu.telegram_user_id = ab.telegram_user_id
       WHERE ab.status = 'active' AND tu.status = 'active'
       ORDER BY ab.telegram_user_id`,
    ).all() as SqliteRow[];
    return rows.map((row) => {
      const username = row.username === null || row.username === undefined ? undefined : String(row.username);
      const displayName = row.display_name === null || row.display_name === undefined
        ? undefined
        : String(row.display_name);
      const user: TelegramUser = {
        telegramUserId: String(row.telegram_user_id),
        chatId: String(row.chat_id),
        ...(username ? { username } : {}),
        ...(displayName ? { displayName } : {}),
        locale: row.locale === 'en' ? 'en' : 'zh',
      };
      return { user, binding: mapBinding(row) };
    });
  }

  public async createSupportTicket(input: {
    telegramUserId: string;
    chatId: string;
    opsChatId: string;
    opsMessageId: number;
  }): Promise<SupportTicket> {
    const ticketNo = `ST-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    this.db.prepare(
      `INSERT INTO support_tickets
         (ticket_no, telegram_user_id, chat_id, ops_chat_id, ops_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      ticketNo,
      input.telegramUserId,
      input.chatId,
      input.opsChatId,
      input.opsMessageId,
      new Date().toISOString(),
    );
    const row = this.db.prepare(
      `SELECT id, ticket_no, telegram_user_id, chat_id, ops_chat_id, ops_message_id,
              status, created_at, closed_at
       FROM support_tickets WHERE ticket_no = ?`,
    ).get(ticketNo) as SqliteRow | undefined;
    if (!row) throw new Error('SQLite support ticket was not persisted');
    return mapSupportTicket(row);
  }

  public async findSupportTicketByOpsMessage(opsChatId: string, opsMessageId: number): Promise<SupportTicket | null> {
    const row = this.db.prepare(
      `SELECT id, ticket_no, telegram_user_id, chat_id, ops_chat_id, ops_message_id,
              status, created_at, closed_at
       FROM support_tickets WHERE ops_chat_id = ? AND ops_message_id = ?`,
    ).get(opsChatId, opsMessageId) as SqliteRow | undefined;
    return row ? mapSupportTicket(row) : null;
  }

  public async closeSupportTicket(ticketNo: string): Promise<void> {
    this.db.prepare(
      "UPDATE support_tickets SET status = 'closed', closed_at = ? WHERE ticket_no = ? AND status = 'open'",
    ).run(new Date().toISOString(), ticketNo);
  }

  public async getStats(): Promise<RepositoryStats> {
    return {
      telegramUsers: this.countRows("SELECT COUNT(*) AS count FROM telegram_users WHERE status = 'active'"),
      activeBindings: this.countRows("SELECT COUNT(*) AS count FROM account_bindings WHERE status = 'active'"),
      openTickets: this.countRows("SELECT COUNT(*) AS count FROM support_tickets WHERE status = 'open'"),
    };
  }

  public async writeAudit(input: {
    actorTelegramUserId?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: BotAuditMetadata;
  }): Promise<void> {
    this.db.prepare(
      `INSERT INTO audit_logs (actor_telegram_user_id, action, target_type, target_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.actorTelegramUserId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(normalizeAuditMetadata(input.metadata)),
      new Date().toISOString(),
    );
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new Error('SQLite repository has not been initialized');
    return this.database;
  }

  private countRows(sql: string): number {
    const row = this.db.prepare(sql).get() as SqliteRow | undefined;
    return Number(row?.count ?? 0);
  }

  private async updateBroadcastStatus(
    broadcastId: string,
    adminTelegramUserId: string,
    from: Broadcast['status'][],
    to: Broadcast['status'],
  ): Promise<Broadcast | null> {
    if (from.length === 0) return null;
    const placeholders = from.map(() => '?').join(', ');
    const result = this.db.prepare(
      `UPDATE broadcasts SET status = ?, updated_at = ?
       WHERE id = ? AND admin_telegram_user_id = ? AND status IN (${placeholders})`,
    ).run(to, new Date().toISOString(), broadcastId, adminTelegramUserId, ...from);
    if (Number(result.changes) !== 1) return null;
    return this.getBroadcast(broadcastId, adminTelegramUserId);
  }

  private refreshBroadcast(broadcastId: string, now: string): void {
    const counts = this.db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
         SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) AS remaining_count
       FROM broadcast_deliveries WHERE broadcast_id = ?`,
    ).get(broadcastId) as SqliteRow | undefined;
    const delivered = Number(counts?.delivered_count ?? 0);
    const failed = Number(counts?.failed_count ?? 0);
    const remaining = Number(counts?.remaining_count ?? 0);
    this.db.prepare(
      `UPDATE broadcasts
       SET delivered_count = ?, failed_count = ?, updated_at = ?,
           status = CASE WHEN status IN ('queued', 'running') AND ? = 0 THEN 'completed' ELSE status END,
           completed_at = CASE WHEN status IN ('queued', 'running') AND ? = 0 THEN ? ELSE completed_at END
       WHERE id = ?`,
    ).run(delivered, failed, now, remaining, remaining, now, broadcastId);
  }
}

export class MemoryRepository implements BotRepository {
  private readonly users = new Map<string, TelegramUser>();
  private readonly bindings = new Map<string, AccountBinding>();
  private readonly updates = new Set<number>();
  private readonly queuedUpdates = new Map<number, {
    payload: string;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    attempts: number;
    availableAt: number;
    leaseExpiresAt?: number;
  }>();
  private readonly broadcasts = new Map<string, Broadcast>();
  private readonly broadcastDeliveries = new Map<string, {
    broadcastId: string;
    telegramUserId: string;
    chatId: string;
    status: 'queued' | 'processing' | 'delivered' | 'failed' | 'cancelled';
    attempts: number;
    availableAt: number;
    leaseExpiresAt?: number;
  }>();
  private readonly notificationPreferences = new Map<string, NotificationPreference>();
  private readonly notificationEvents = new Set<string>();
  private readonly tickets = new Map<string, SupportTicket>();
  private readonly ticketsByOpsMessage = new Map<string, string>();
  private nextTicketId = 1;
  public readonly audits: Array<Record<string, unknown>> = [];

  public async init(): Promise<void> {}
  public async close(): Promise<void> {}

  public async claimUpdate(updateId: number): Promise<boolean> {
    if (this.updates.has(updateId)) return false;
    this.updates.add(updateId);
    return true;
  }

  public async releaseUpdate(updateId: number): Promise<void> {
    this.updates.delete(updateId);
  }

  public async enqueueTelegramUpdate(updateId: number, payload: string): Promise<boolean> {
    if (this.queuedUpdates.has(updateId)) return false;
    this.queuedUpdates.set(updateId, {
      payload,
      status: 'queued',
      attempts: 0,
      availableAt: Date.now(),
    });
    return true;
  }

  public async claimQueuedTelegramUpdate(): Promise<QueuedTelegramUpdate | null> {
    const now = Date.now();
    for (const [updateId, queued] of this.queuedUpdates) {
      const available = queued.status === 'queued' && queued.availableAt <= now;
      const leaseExpired = queued.status === 'processing' && (queued.leaseExpiresAt ?? 0) <= now;
      if (!available && !leaseExpired) continue;
      queued.status = 'processing';
      queued.attempts += 1;
      queued.leaseExpiresAt = now + 60_000;
      return { updateId, payload: queued.payload, attempts: queued.attempts };
    }
    return null;
  }

  public async completeQueuedTelegramUpdate(updateId: number): Promise<void> {
    const queued = this.queuedUpdates.get(updateId);
    if (!queued) return;
    queued.status = 'completed';
    queued.payload = '';
    delete queued.leaseExpiresAt;
  }

  public async retryQueuedTelegramUpdate(
    updateId: number,
    retryAt: Date,
  ): Promise<'queued' | 'failed'> {
    const queued = this.queuedUpdates.get(updateId);
    if (!queued) return 'failed';
    delete queued.leaseExpiresAt;
    if (queued.attempts >= 5) {
      queued.status = 'failed';
      queued.payload = '';
      return 'failed';
    }
    queued.status = 'queued';
    queued.availableAt = retryAt.getTime();
    return 'queued';
  }

  public async createBroadcastDraft(input: {
    id: string;
    adminTelegramUserId: string;
    message: string;
    recipients: BroadcastRecipient[];
  }): Promise<Broadcast> {
    const recipients = uniqueBroadcastRecipients(input.recipients);
    const now = new Date();
    const broadcast: Broadcast = {
      id: input.id,
      adminTelegramUserId: input.adminTelegramUserId,
      message: input.message,
      status: 'draft',
      targetCount: recipients.length,
      delivered: 0,
      failed: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.broadcasts.set(broadcast.id, broadcast);
    for (const recipient of recipients) {
      this.broadcastDeliveries.set(this.broadcastDeliveryKey(broadcast.id, recipient.telegramUserId), {
        broadcastId: broadcast.id,
        telegramUserId: recipient.telegramUserId,
        chatId: recipient.chatId,
        status: 'queued',
        attempts: 0,
        availableAt: now.getTime(),
      });
    }
    return { ...broadcast };
  }

  public async getBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    const broadcast = this.broadcasts.get(broadcastId);
    if (!broadcast || broadcast.adminTelegramUserId !== adminTelegramUserId) return null;
    return { ...broadcast };
  }

  public async queueBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    const broadcast = this.broadcasts.get(broadcastId);
    if (!broadcast || broadcast.adminTelegramUserId !== adminTelegramUserId || broadcast.status !== 'draft') return null;
    const now = new Date();
    const updated: Broadcast = broadcast.targetCount === 0
      ? { ...broadcast, status: 'completed', updatedAt: now, completedAt: now }
      : { ...broadcast, status: 'queued', updatedAt: now };
    this.broadcasts.set(broadcastId, updated);
    return { ...updated };
  }

  public async pauseBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    return this.updateMemoryBroadcastStatus(broadcastId, adminTelegramUserId, ['queued', 'running'], 'paused');
  }

  public async resumeBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    return this.updateMemoryBroadcastStatus(broadcastId, adminTelegramUserId, ['paused'], 'queued');
  }

  public async cancelBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null> {
    const broadcast = this.broadcasts.get(broadcastId);
    if (!broadcast || broadcast.adminTelegramUserId !== adminTelegramUserId
      || !['draft', 'queued', 'running', 'paused'].includes(broadcast.status)) return null;
    const updated = { ...broadcast, status: 'cancelled' as const, updatedAt: new Date() };
    this.broadcasts.set(broadcastId, updated);
    for (const delivery of this.broadcastDeliveries.values()) {
      if (delivery.broadcastId !== broadcastId || delivery.status !== 'queued') continue;
      delivery.status = 'cancelled';
      delete delivery.leaseExpiresAt;
    }
    return { ...updated };
  }

  public async claimBroadcastDelivery(): Promise<QueuedBroadcastDelivery | null> {
    const now = Date.now();
    for (const delivery of this.broadcastDeliveries.values()) {
      const broadcast = this.broadcasts.get(delivery.broadcastId);
      if (!broadcast || !['queued', 'running'].includes(broadcast.status)) continue;
      const available = delivery.status === 'queued' && delivery.availableAt <= now;
      const leaseExpired = delivery.status === 'processing' && (delivery.leaseExpiresAt ?? 0) <= now;
      if (!available && !leaseExpired) continue;
      delivery.status = 'processing';
      delivery.attempts += 1;
      delivery.leaseExpiresAt = now + 60_000;
      if (broadcast.status === 'queued') this.broadcasts.set(broadcast.id, { ...broadcast, status: 'running', updatedAt: new Date() });
      return {
        broadcastId: delivery.broadcastId,
        telegramUserId: delivery.telegramUserId,
        chatId: delivery.chatId,
        message: broadcast.message,
        attempts: delivery.attempts,
      };
    }
    return null;
  }

  public async completeBroadcastDelivery(broadcastId: string, telegramUserId: string): Promise<void> {
    const delivery = this.broadcastDeliveries.get(this.broadcastDeliveryKey(broadcastId, telegramUserId));
    if (!delivery || delivery.status !== 'processing') return;
    delivery.status = 'delivered';
    delete delivery.leaseExpiresAt;
    this.refreshMemoryBroadcast(broadcastId);
  }

  public async retryBroadcastDelivery(
    broadcastId: string,
    telegramUserId: string,
    retryAt: Date,
  ): Promise<'queued' | 'failed' | 'cancelled'> {
    const delivery = this.broadcastDeliveries.get(this.broadcastDeliveryKey(broadcastId, telegramUserId));
    const broadcast = this.broadcasts.get(broadcastId);
    if (!delivery || !broadcast || broadcast.status === 'cancelled') {
      if (delivery?.status === 'processing') {
        delivery.status = 'cancelled';
        delete delivery.leaseExpiresAt;
      }
      return 'cancelled';
    }
    if (delivery.status !== 'processing') return 'cancelled';
    delete delivery.leaseExpiresAt;
    if (delivery.attempts >= 5) {
      delivery.status = 'failed';
      this.refreshMemoryBroadcast(broadcastId);
      return 'failed';
    }
    delivery.status = 'queued';
    delivery.availableAt = retryAt.getTime();
    this.refreshMemoryBroadcast(broadcastId);
    return 'queued';
  }

  public async upsertTelegramUser(user: TelegramUser): Promise<TelegramUser> {
    const existing = this.users.get(user.telegramUserId);
    const saved = existing ? { ...user, locale: existing.locale } : user;
    this.users.set(user.telegramUserId, saved);
    return saved;
  }

  public async setTelegramUserLocale(telegramUserId: string, locale: TelegramUser['locale']): Promise<void> {
    const existing = this.users.get(telegramUserId);
    if (existing) this.users.set(telegramUserId, { ...existing, locale });
  }

  public async getBinding(telegramUserId: string): Promise<AccountBinding | null> {
    const binding = this.bindings.get(telegramUserId);
    return binding?.status === 'active' ? binding : null;
  }

  public async saveBinding(binding: AccountBinding): Promise<void> {
    this.bindings.set(binding.telegramUserId, binding);
  }

  public async revokeBinding(telegramUserId: string): Promise<void> {
    const binding = this.bindings.get(telegramUserId);
    if (binding) this.bindings.set(telegramUserId, { ...binding, status: 'revoked' });
  }

  public async getNotificationPreference(telegramUserId: string): Promise<NotificationPreference> {
    return this.notificationPreferences.get(telegramUserId) ?? {
      telegramUserId,
      subscriptionNoticeDays: 3,
      paused: false,
      updatedAt: new Date(),
    };
  }

  public async saveNotificationPreference(preference: NotificationPreference): Promise<void> {
    this.notificationPreferences.set(preference.telegramUserId, preference);
  }

  public async claimNotificationEvent(eventKey: string, _telegramUserId: string, _kind: string): Promise<boolean> {
    if (this.notificationEvents.has(eventKey)) return false;
    this.notificationEvents.add(eventKey);
    return true;
  }

  public async clearNotificationEvent(eventKey: string): Promise<void> {
    this.notificationEvents.delete(eventKey);
  }

  public async listActiveBindings(): Promise<ActiveBinding[]> {
    const result: ActiveBinding[] = [];
    for (const binding of this.bindings.values()) {
      if (binding.status !== 'active') continue;
      const user = this.users.get(binding.telegramUserId);
      if (user) result.push({ user, binding });
    }
    return result;
  }

  public async createSupportTicket(input: {
    telegramUserId: string;
    chatId: string;
    opsChatId: string;
    opsMessageId: number;
  }): Promise<SupportTicket> {
    const id = this.nextTicketId++;
    const ticket: SupportTicket = {
      id,
      ticketNo: `ST-${String(id).padStart(6, '0')}`,
      ...input,
      status: 'open',
      createdAt: new Date(),
    };
    this.tickets.set(ticket.ticketNo, ticket);
    this.ticketsByOpsMessage.set(`${input.opsChatId}:${input.opsMessageId}`, ticket.ticketNo);
    return ticket;
  }

  public async findSupportTicketByOpsMessage(opsChatId: string, opsMessageId: number): Promise<SupportTicket | null> {
    const ticketNo = this.ticketsByOpsMessage.get(`${opsChatId}:${opsMessageId}`);
    return ticketNo ? this.tickets.get(ticketNo) ?? null : null;
  }

  public async closeSupportTicket(ticketNo: string): Promise<void> {
    const ticket = this.tickets.get(ticketNo);
    if (ticket?.status === 'open') this.tickets.set(ticketNo, { ...ticket, status: 'closed', closedAt: new Date() });
  }

  public async getStats(): Promise<RepositoryStats> {
    return {
      telegramUsers: [...this.users.values()].filter((user) => user).length,
      activeBindings: [...this.bindings.values()].filter((binding) => binding.status === 'active').length,
      openTickets: [...this.tickets.values()].filter((ticket) => ticket.status === 'open').length,
    };
  }

  public async writeAudit(input: {
    actorTelegramUserId?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: BotAuditMetadata;
  }): Promise<void> {
    this.audits.push({ ...input, metadata: normalizeAuditMetadata(input.metadata), createdAt: new Date().toISOString() });
  }

  private async updateMemoryBroadcastStatus(
    broadcastId: string,
    adminTelegramUserId: string,
    from: Broadcast['status'][],
    to: Broadcast['status'],
  ): Promise<Broadcast | null> {
    const broadcast = this.broadcasts.get(broadcastId);
    if (!broadcast || broadcast.adminTelegramUserId !== adminTelegramUserId || !from.includes(broadcast.status)) return null;
    const updated = { ...broadcast, status: to, updatedAt: new Date() };
    this.broadcasts.set(broadcastId, updated);
    return { ...updated };
  }

  private refreshMemoryBroadcast(broadcastId: string): void {
    const broadcast = this.broadcasts.get(broadcastId);
    if (!broadcast) return;
    let delivered = 0;
    let failed = 0;
    let remaining = 0;
    for (const delivery of this.broadcastDeliveries.values()) {
      if (delivery.broadcastId !== broadcastId) continue;
      if (delivery.status === 'delivered') delivered += 1;
      if (delivery.status === 'failed') failed += 1;
      if (delivery.status === 'queued' || delivery.status === 'processing') remaining += 1;
    }
    const now = new Date();
    const completed = ['queued', 'running'].includes(broadcast.status) && remaining === 0;
    this.broadcasts.set(broadcastId, {
      ...broadcast,
      delivered,
      failed,
      updatedAt: now,
      ...(completed ? { status: 'completed', completedAt: now } : {}),
    });
  }

  private broadcastDeliveryKey(broadcastId: string, telegramUserId: string): string {
    return `${broadcastId}:${telegramUserId}`;
  }
}

function mapSupportTicket(row: Record<string, unknown>): SupportTicket {
  return {
    id: Number(row.id),
    ticketNo: String(row.ticket_no),
    telegramUserId: String(row.telegram_user_id),
    chatId: String(row.chat_id),
    opsChatId: String(row.ops_chat_id),
    opsMessageId: Number(row.ops_message_id),
    status: row.status === 'closed' ? 'closed' : 'open',
    createdAt: parseDatabaseDate(row.created_at),
    ...(row.closed_at ? { closedAt: parseDatabaseDate(row.closed_at) } : {}),
  };
}

function mapBinding(row: Record<string, unknown>): AccountBinding {
  return {
    telegramUserId: String(row.telegram_user_id),
    newApiUserId: Number(row.new_api_user_id),
    usernameSnapshot: String(row.username_snapshot),
    status: row.status === 'revoked' ? 'revoked' : 'active',
    verifiedAt: parseDatabaseDate(row.verified_at),
    lastVerifiedAt: parseDatabaseDate(row.last_verified_at),
  };
}

function mapTelegramUser(row: Record<string, unknown>): TelegramUser {
  const username = row.username === null || row.username === undefined ? undefined : String(row.username);
  const displayName = row.display_name === null || row.display_name === undefined ? undefined : String(row.display_name);
  return {
    telegramUserId: String(row.telegram_user_id),
    chatId: String(row.chat_id),
    ...(username ? { username } : {}),
    ...(displayName ? { displayName } : {}),
    locale: row.locale === 'en' ? 'en' : 'zh',
  };
}

function mapQueuedTelegramUpdate(row: Record<string, unknown>): QueuedTelegramUpdate {
  return {
    updateId: Number(row.update_id),
    payload: String(row.payload),
    attempts: Number(row.attempts),
  };
}

function mapBroadcast(row: Record<string, unknown>): Broadcast {
  const status = String(row.status);
  if (!['draft', 'queued', 'running', 'paused', 'completed', 'cancelled'].includes(status)) {
    throw new Error('broadcast status is invalid');
  }
  return {
    id: String(row.id),
    adminTelegramUserId: String(row.admin_telegram_user_id),
    message: String(row.message),
    status: status as Broadcast['status'],
    targetCount: Number(row.target_count),
    delivered: Number(row.delivered_count),
    failed: Number(row.failed_count),
    createdAt: parseDatabaseDate(row.created_at),
    updatedAt: parseDatabaseDate(row.updated_at),
    ...(row.completed_at ? { completedAt: parseDatabaseDate(row.completed_at) } : {}),
  };
}

function mapQueuedBroadcastDelivery(row: Record<string, unknown>): QueuedBroadcastDelivery {
  return {
    broadcastId: String(row.broadcast_id),
    telegramUserId: String(row.telegram_user_id),
    chatId: String(row.chat_id),
    message: String(row.message),
    attempts: Number(row.attempts),
  };
}

function uniqueBroadcastRecipients(recipients: BroadcastRecipient[]): BroadcastRecipient[] {
  const unique = new Map<string, BroadcastRecipient>();
  for (const recipient of recipients) {
    if (!recipient.telegramUserId || !recipient.chatId) continue;
    unique.set(recipient.telegramUserId, recipient);
  }
  return [...unique.values()];
}

function normalizeAuditMetadata(metadata: BotAuditMetadata | undefined): BotAuditMetadata {
  const normalized: BotAuditMetadata = {};
  for (const key of ['threshold', 'targetCount', 'delivered', 'failed'] as const) {
    const value = metadata?.[key];
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0) normalized[key] = value;
  }
  return normalized;
}

function parseDatabaseDate(value: unknown): Date {
  if (value instanceof Date) return new Date(value.getTime());
  const text = String(value);
  // PostgreSQL returns an offset, while SQLite defaults use a UTC timestamp without one.
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  return new Date(normalized);
}

function resolveSqliteDatabasePath(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'sqlite:') throw new Error('SQLite database URL must use the sqlite: scheme');
  if (url.search || url.hash) throw new Error('SQLite DATABASE_URL cannot include query parameters or fragments');
  if (url.hostname && url.hostname !== 'localhost') throw new Error('SQLite DATABASE_URL cannot include a hostname');
  if (url.pathname === ':memory:') return ':memory:';
  if (!url.pathname) throw new Error('SQLite DATABASE_URL must include a database file path');
  return resolve(decodeURIComponent(url.pathname));
}

export async function createRepository(databaseUrl: string | undefined, logger: Logger): Promise<BotRepository> {
  const repository = !databaseUrl
    ? new MemoryRepository()
    : databaseUrl.startsWith('sqlite:')
      ? new SqliteRepository(databaseUrl, logger)
      : databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')
        ? new PostgresRepository(databaseUrl, logger)
        : (() => { throw new Error('DATABASE_URL must use sqlite:, postgres://, or postgresql://'); })();
  await repository.init();
  if (!databaseUrl) logger.warn('DATABASE_URL is not set; using in-memory storage');
  return repository;
}
