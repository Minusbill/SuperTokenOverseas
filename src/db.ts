import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import type {
  AccountBinding,
  ActiveBinding,
  BotAuditMetadata,
  BotRepository,
  NotificationPreference,
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
}

export class MemoryRepository implements BotRepository {
  private readonly users = new Map<string, TelegramUser>();
  private readonly bindings = new Map<string, AccountBinding>();
  private readonly updates = new Set<number>();
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
