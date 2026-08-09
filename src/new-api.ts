import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { NewApiAccount, NewApiStatus, Subscription, UsageStat } from './types.js';

const apiEnvelopeSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});

const accountSchema = z.object({
  id: z.coerce.number().int().positive(),
  username: z.string(),
  display_name: z.string().optional(),
  telegram_id: z.union([z.string(), z.number()]).optional(),
  status: z.coerce.number(),
  group: z.string().optional(),
  quota: z.coerce.number(),
  used_quota: z.coerce.number(),
  request_count: z.coerce.number().optional(),
});

const statusSchema = z.object({
  version: z.string().optional(),
  quota_per_unit: z.coerce.number().positive(),
  quota_display_type: z.enum(['USD', 'CNY', 'TOKENS', 'CUSTOM']),
  custom_currency_symbol: z.string().optional(),
  custom_currency_exchange_rate: z.coerce.number().optional(),
  usd_exchange_rate: z.coerce.number().optional(),
  system_name: z.string().optional(),
});

const usageSchema = z.object({
  quota: z.coerce.number(),
  rpm: z.coerce.number().optional(),
  tpm: z.coerce.number().optional(),
});

const noticeSchema = z.string();

const subscriptionSchema = z.object({
  id: z.coerce.number(),
  plan_id: z.coerce.number().optional(),
  status: z.string().optional(),
  start_time: z.coerce.number(),
  end_time: z.coerce.number(),
  amount_total: z.coerce.number().optional(),
  amount_used: z.coerce.number().optional(),
});

export class NewApiError extends Error {
  public constructor(
    public readonly code: 'timeout' | 'http' | 'api' | 'contract' | 'config',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'NewApiError';
  }
}

function unwrapData(payload: unknown): unknown {
  const envelope = apiEnvelopeSchema.safeParse(payload);
  if (!envelope.success) return payload;
  if (envelope.data.success === false) {
    throw new NewApiError('api', envelope.data.message ?? 'new-api returned an unsuccessful response');
  }
  return envelope.data.data ?? payload;
}

function mapAccount(input: z.infer<typeof accountSchema>): NewApiAccount {
  return {
    id: input.id,
    username: input.username,
    ...(input.display_name ? { displayName: input.display_name } : {}),
    ...(input.telegram_id !== undefined ? { telegramId: String(input.telegram_id) } : {}),
    status: input.status,
    ...(input.group ? { group: input.group } : {}),
    quota: input.quota,
    usedQuota: input.used_quota,
    ...(input.request_count !== undefined ? { requestCount: input.request_count } : {}),
  };
}

function mapStatus(input: z.infer<typeof statusSchema>): NewApiStatus {
  return {
    ...(input.version ? { version: input.version } : {}),
    quotaPerUnit: input.quota_per_unit,
    quotaDisplayType: input.quota_display_type,
    ...(input.custom_currency_symbol ? { customCurrencySymbol: input.custom_currency_symbol } : {}),
    ...(input.custom_currency_exchange_rate !== undefined
      ? { customCurrencyExchangeRate: input.custom_currency_exchange_rate }
      : {}),
    ...(input.usd_exchange_rate !== undefined ? { usdExchangeRate: input.usd_exchange_rate } : {}),
    ...(input.system_name ? { systemName: input.system_name } : {}),
  };
}

function mapSubscription(input: z.infer<typeof subscriptionSchema>): Subscription {
  const remaining = input.amount_total !== undefined && input.amount_used !== undefined
    ? input.amount_total - input.amount_used
    : undefined;
  return {
    id: input.id,
    ...(input.plan_id !== undefined ? { planId: input.plan_id, planName: `订阅套餐 #${input.plan_id}` } : {}),
    ...(input.status ? { status: input.status } : {}),
    startTime: input.start_time,
    endTime: input.end_time,
    ...(input.amount_total !== undefined ? { amount: input.amount_total } : {}),
    ...(input.amount_used !== undefined ? { usedAmount: input.amount_used } : {}),
    ...(remaining !== undefined ? { remainingAmount: remaining } : {}),
  };
}

export class NewApiClient {
  public constructor(private readonly config: Config, private readonly logger: Logger) {}

  public async getStatus(): Promise<NewApiStatus> {
    const payload = await this.request('/api/status');
    const parsed = statusSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api status response changed');
    return mapStatus(parsed.data);
  }

  public async getNotice(): Promise<string> {
    const payload = await this.request('/api/notice');
    const parsed = noticeSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api notice response changed');
    return parsed.data.trim();
  }

  public async getAccountById(userId: number): Promise<NewApiAccount> {
    if (this.config.newApiIntegrationMode !== 'admin') {
      throw new NewApiError('config', 'getAccountById is only available in admin integration mode');
    }
    const payload = await this.request(`/api/user/${encodeURIComponent(String(userId))}`);
    return this.parseAccount(unwrapData(payload));
  }

  public async resolveAccountByTelegramId(telegramId: string): Promise<NewApiAccount> {
    if (this.config.newApiIntegrationMode !== 'bridge') {
      throw new NewApiError('config', 'resolveAccountByTelegramId requires bridge integration mode');
    }
    const payload = await this.request('/api/integrations/telegram/account/summary', {
      method: 'POST',
      body: { telegram_id: telegramId },
    });
    return this.parseAccount(unwrapData(payload));
  }

  public async getUsage(account: NewApiAccount, startTimestamp: number, endTimestamp: number): Promise<UsageStat> {
    if (this.config.newApiIntegrationMode === 'bridge') {
      const payload = await this.request('/api/integrations/telegram/account/usage', {
        method: 'POST',
        body: { telegram_id: account.telegramId, start_timestamp: startTimestamp, end_timestamp: endTimestamp },
      });
      return this.parseUsage(unwrapData(payload));
    }
    const query = new URLSearchParams({
      username: account.username,
      start_timestamp: String(startTimestamp),
      end_timestamp: String(endTimestamp),
    });
    const payload = await this.request(`/api/log/stat?${query.toString()}`);
    return this.parseUsage(unwrapData(payload));
  }

  public async getSubscriptions(account: NewApiAccount): Promise<Subscription[]> {
    if (this.config.newApiIntegrationMode === 'bridge') {
      const payload = await this.request('/api/integrations/telegram/account/subscriptions', {
        method: 'POST',
        body: { telegram_id: account.telegramId },
      });
      return this.parseSubscriptions(unwrapData(payload));
    }
    const payload = await this.request(`/api/subscription/admin/users/${account.id}/subscriptions`);
    return this.parseSubscriptions(unwrapData(payload));
  }

  private parseAccount(value: unknown): NewApiAccount {
    const parsed = accountSchema.safeParse(value);
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues }, 'new-api account contract mismatch');
      throw new NewApiError('contract', 'new-api account response changed');
    }
    return mapAccount(parsed.data);
  }

  private parseUsage(value: unknown): UsageStat {
    const parsed = usageSchema.safeParse(value);
    if (!parsed.success) throw new NewApiError('contract', 'new-api usage response changed');
    return {
      quota: parsed.data.quota,
      ...(parsed.data.rpm !== undefined ? { rpm: parsed.data.rpm } : {}),
      ...(parsed.data.tpm !== undefined ? { tpm: parsed.data.tpm } : {}),
    };
  }

  private parseSubscriptions(value: unknown): Subscription[] {
    const candidates = Array.isArray(value)
      ? value.map((item) => {
          if (typeof item === 'object' && item !== null && 'subscription' in item) {
            return (item as { subscription: unknown }).subscription;
          }
          return item;
        })
      : typeof value === 'object' && value !== null && 'subscriptions' in value
        ? (value as { subscriptions: unknown }).subscriptions
        : [];
    if (!Array.isArray(candidates)) throw new NewApiError('contract', 'new-api subscription response changed');
    const parsed = z.array(subscriptionSchema).safeParse(candidates);
    if (!parsed.success) throw new NewApiError('contract', 'new-api subscription response changed');
    return parsed.data.map(mapSubscription);
  }

  private async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.newApiRequestTimeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    if (this.config.newApiIntegrationMode === 'admin' && this.config.newApiAdminPat) {
      headers.Authorization = `Bearer ${this.config.newApiAdminPat}`;
    }
    if (this.config.newApiIntegrationMode === 'bridge' && this.config.newApiIntegrationSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = cryptoRandomNonce();
      const bodyHash = createHash('sha256').update(body ?? '').digest('hex');
      const canonical = [options.method ?? 'GET', path, bodyHash, timestamp, nonce].join('\n');
      headers['X-Integration-Timestamp'] = timestamp;
      headers['X-Integration-Nonce'] = nonce;
      headers['X-Integration-Signature'] = createHmac('sha256', this.config.newApiIntegrationSecret)
        .update(canonical)
        .digest('hex');
    }

    try {
      const requestInit: RequestInit = {
        method: options.method ?? 'GET',
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) requestInit.body = body;
      const response = await fetch(`${this.config.newApiBaseUrl}${path}`, requestInit);
      const raw = await response.text();
      let payload: unknown;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        throw new NewApiError('contract', 'new-api returned invalid JSON', response.status);
      }
      if (!response.ok) {
        throw new NewApiError('http', `new-api returned HTTP ${response.status}`, response.status);
      }
      return payload;
    } catch (error) {
      if (error instanceof NewApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new NewApiError('timeout', 'new-api request timed out');
      }
      throw new NewApiError('http', 'new-api request failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function cryptoRandomNonce(): string {
  return randomBytes(16).toString('hex');
}
