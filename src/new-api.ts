import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type {
  AvailableModelPage,
  ApiAccess,
  ApiKey,
  CryptoAsset,
  CryptoNetwork,
  NewApiAccount,
  NewApiStatus,
  Subscription,
  TopUpOptions,
  TopUpOrder,
  TopUpQuote,
  TopUpStatus,
  UsageStat,
} from './types.js';

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

const availableModelPageSchema = z.object({
  models: z.array(z.object({
    id: z.string().min(1).max(255),
    endpoint_types: z.array(z.string().min(1).max(80)).max(16),
  })).max(20),
  total: z.coerce.number().int().nonnegative().max(10000),
  next_cursor: z.string().regex(/^\d{1,5}$/).optional(),
});

const publicPricingModelSchema = z.object({
  model_name: z.string().min(1).max(255),
  supported_endpoint_types: z.array(z.string().min(1).max(80)).max(16).optional(),
});

const apiKeyProfileSchema = z.object({
  id: z.string().min(1).max(255),
  label: z.string().min(1).max(255),
  auto_groups: z.array(z.string().min(1).max(255)).max(64).optional(),
});

const apiAccessSchema = z.object({
  base_url: z.string().url(),
  key_management_url: z.string().url(),
  profiles: z.array(apiKeyProfileSchema).max(128),
  key_limit: z.coerce.number().int().positive().max(10000),
});

const apiKeyStatusSchema = z.enum(['enabled', 'disabled', 'expired', 'exhausted', 'unknown']);
const apiKeySchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().min(1).max(80),
  masked_key: z.string().min(1).max(128).refine((value) => value.includes('*'), 'masked key is required'),
  status: apiKeyStatusSchema,
  group: z.string().max(255),
  auto_groups: z.array(z.string().min(1).max(255)).max(64).optional(),
  created_at: z.coerce.number().int().positive(),
  expires_at: z.coerce.number().int(),
});

const apiKeyListSchema = z.object({ keys: z.array(apiKeySchema).max(20) });

const cryptoAssetSchema = z.enum(['USDT', 'USDC']);
const cryptoNetworkSchema = z.enum(['bsc', 'ethereum', 'base', 'solana']);

const topUpPaymentMethodSchema = z.object({
  type: z.enum(['alipay', 'wxpay', 'crypto']),
  name: z.string().min(1).max(80),
  min_topup: z.coerce.number().int().nonnegative().optional(),
  crypto_networks: z.array(z.object({
    network: cryptoNetworkSchema,
    name: z.string().min(1).max(80),
    assets: z.array(cryptoAssetSchema).min(1).max(2),
    required_confirmations: z.coerce.number().int().positive().max(128),
  })).min(1).max(4).optional(),
});

const topUpOptionsSchema = z.object({
  enabled: z.boolean(),
  display_type: z.enum(['USD', 'CNY', 'TOKENS', 'CUSTOM']),
  min_topup: z.coerce.number().int().positive(),
  amount_options: z.array(z.coerce.number().int().positive()).max(20),
  payment_methods: z.array(topUpPaymentMethodSchema).max(3),
});

const topUpStatusValueSchema = z.enum(['pending', 'processing', 'success', 'failed', 'expired']);
const monetaryAmountSchema = z.string().regex(/^\d+(?:\.\d{1,12})?$/);

const topUpQuoteSchema = z.object({
  topup_amount: z.coerce.number().int().positive(),
  payment_method: z.enum(['alipay', 'wxpay', 'crypto']),
  payable_amount: monetaryAmountSchema,
  expires_in: z.coerce.number().int().positive(),
  crypto_asset: cryptoAssetSchema.optional(),
  crypto_network: cryptoNetworkSchema.optional(),
}).superRefine((quote, context) => {
  if (quote.payment_method !== 'crypto' && !/^\d+\.\d{2}$/.test(quote.payable_amount)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'fiat quote must use two decimal places' });
  }
});

const topUpOrderSchema = z.object({
  order_ref: z.string().min(1).max(80),
  status: topUpStatusValueSchema,
  topup_amount: z.coerce.number().int().positive(),
  payment_method: z.enum(['alipay', 'wxpay', 'crypto']),
  payable_amount: monetaryAmountSchema,
  checkout_url: z.string().url().optional(),
  crypto_asset: cryptoAssetSchema.optional(),
  crypto_network: cryptoNetworkSchema.optional(),
  deposit_address: z.string().min(1).max(160).optional(),
  deposit_memo: z.string().min(1).max(160).optional(),
  required_confirmations: z.coerce.number().int().positive().max(128).optional(),
  expires_at: z.coerce.number().int().positive(),
}).superRefine((order, context) => {
  if (order.payment_method === 'crypto') {
    if (!order.crypto_asset || !order.crypto_network || !order.deposit_address || !order.required_confirmations) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'crypto order is incomplete' });
    }
  } else if (!order.checkout_url) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'checkout URL is required' });
  }
  if (order.payment_method !== 'crypto' && !/^\d+\.\d{2}$/.test(order.payable_amount)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'fiat order must use two decimal places' });
  }
});

const topUpStatusSchema = z.object({
  order_ref: z.string().min(1).max(80),
  status: topUpStatusValueSchema,
  payment_method: z.enum(['alipay', 'wxpay', 'crypto']),
  payable_amount: monetaryAmountSchema,
  crypto_asset: cryptoAssetSchema.optional(),
  crypto_network: cryptoNetworkSchema.optional(),
  required_confirmations: z.coerce.number().int().positive().max(128).optional(),
  created_at: z.coerce.number().int().positive(),
  completed_at: z.coerce.number().int().nonnegative().optional(),
  expires_at: z.coerce.number().int().positive(),
}).superRefine((status, context) => {
  if (status.payment_method !== 'crypto' && !/^\d+\.\d{2}$/.test(status.payable_amount)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'fiat status must use two decimal places' });
  }
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
    const payload = await this.request('/api/status', { authenticated: false });
    const parsed = statusSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api status response changed');
    return mapStatus(parsed.data);
  }

  public async getNotice(): Promise<string> {
    const payload = await this.request('/api/notice', { authenticated: false });
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
    const payload = await this.request('/api/integrations/telegram/v1/account/summary', {
      method: 'POST',
      body: { telegram_id: telegramId },
    });
    return this.parseAccount(unwrapData(payload));
  }

  public async getUsage(account: NewApiAccount, startTimestamp: number, endTimestamp: number): Promise<UsageStat> {
    if (this.config.newApiIntegrationMode === 'bridge') {
      const payload = await this.request('/api/integrations/telegram/v1/account/usage', {
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
      const payload = await this.request('/api/integrations/telegram/v1/account/subscriptions', {
        method: 'POST',
        body: { telegram_id: account.telegramId },
      });
      return this.parseSubscriptions(unwrapData(payload));
    }
    const payload = await this.request(`/api/subscription/admin/users/${account.id}/subscriptions`);
    return this.parseSubscriptions(unwrapData(payload));
  }

  public async getAvailableModels(telegramId: string, cursor?: string): Promise<AvailableModelPage> {
    this.requireBridge('getAvailableModels');
    const payload = await this.request('/api/integrations/telegram/v1/models', {
      method: 'POST',
      body: { telegram_id: telegramId, ...(cursor ? { cursor } : {}) },
    });
    const parsed = availableModelPageSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api available models response changed');
    return {
      models: parsed.data.models.map((model) => ({ id: model.id, endpointTypes: model.endpoint_types })),
      total: parsed.data.total,
      ...(parsed.data.next_cursor ? { nextCursor: parsed.data.next_cursor } : {}),
    };
  }

  // Official new-api exposes this as a catalogue, not a user-delegation API.
  // Keep the request anonymous so an admin PAT cannot accidentally make the
  // result look like the Telegram user's authorized model set.
  public async getPublicModels(cursor?: string): Promise<AvailableModelPage> {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) {
      throw new NewApiError('config', 'invalid public model cursor');
    }
    const payload = await this.request('/api/pricing', { authenticated: false });
    const value = unwrapData(payload);
    const candidates = Array.isArray(value)
      ? value
      : typeof value === 'object' && value !== null && Array.isArray((value as { models?: unknown }).models)
        ? (value as { models: unknown[] }).models
        : null;
    if (!candidates) throw new NewApiError('contract', 'new-api pricing response changed');
    const parsed = z.array(publicPricingModelSchema).safeParse(candidates);
    if (!parsed.success) throw new NewApiError('contract', 'new-api pricing response changed');
    const pageSize = 12;
    const models = parsed.data.slice(offset, offset + pageSize).map((model) => ({
      id: model.model_name,
      endpointTypes: model.supported_endpoint_types ?? [],
    }));
    const nextOffset = offset + models.length;
    return {
      models,
      total: parsed.data.length,
      ...(nextOffset < parsed.data.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  public async getApiAccess(telegramId: string): Promise<ApiAccess> {
    this.requireBridge('getApiAccess');
    const payload = await this.request('/api/integrations/telegram/v1/api-access', {
      method: 'POST', body: { telegram_id: telegramId },
    });
    const parsed = apiAccessSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api api access response changed');
    return {
      baseUrl: parsed.data.base_url,
      keyManagementUrl: parsed.data.key_management_url,
      profiles: parsed.data.profiles.map((profile) => ({
        id: profile.id, label: profile.label, ...(profile.auto_groups ? { autoGroups: profile.auto_groups } : {}),
      })),
      keyLimit: parsed.data.key_limit,
    };
  }

  public async listApiKeys(telegramId: string): Promise<ApiKey[]> {
    this.requireBridge('listApiKeys');
    const payload = await this.request('/api/integrations/telegram/v1/keys', {
      method: 'POST', body: { telegram_id: telegramId },
    });
    const parsed = apiKeyListSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api api key list response changed');
    return parsed.data.keys.map(mapApiKey);
  }

  public async createApiKey(telegramId: string, profileIndex: number, idempotencyKey: string): Promise<ApiKey> {
	this.requireBridge('createApiKey');
	const payload = await this.request('/api/integrations/telegram/v1/keys/create', {
	  method: 'POST', body: { telegram_id: telegramId, profile_index: profileIndex, idempotency_key: idempotencyKey },
	});
    return this.parseApiKey(unwrapData(payload));
  }

  public async setApiKeyStatus(telegramId: string, tokenId: number, enabled: boolean): Promise<ApiKey> {
    this.requireBridge('setApiKeyStatus');
    const payload = await this.request('/api/integrations/telegram/v1/keys/status', {
      method: 'POST', body: { telegram_id: telegramId, token_id: tokenId, enabled },
    });
    return this.parseApiKey(unwrapData(payload));
  }

  public async deleteApiKey(telegramId: string, tokenId: number): Promise<void> {
    this.requireBridge('deleteApiKey');
    const payload = await this.request('/api/integrations/telegram/v1/keys/delete', {
      method: 'POST', body: { telegram_id: telegramId, token_id: tokenId },
    });
    const parsed = z.object({ deleted: z.literal(true) }).safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api api key delete response changed');
  }

  public async getTopUpOptions(telegramId: string): Promise<TopUpOptions> {
    this.requireBridge('getTopUpOptions');
    const payload = await this.request('/api/integrations/telegram/v1/topup/options', {
      method: 'POST',
      body: { telegram_id: telegramId },
    });
    const parsed = topUpOptionsSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api topup options response changed');
    return {
      enabled: parsed.data.enabled,
      displayType: parsed.data.display_type,
      minTopup: parsed.data.min_topup,
      amountOptions: parsed.data.amount_options,
      paymentMethods: parsed.data.payment_methods.map((method) => ({
        type: method.type,
        name: method.name,
        ...(method.min_topup !== undefined ? { minTopup: method.min_topup } : {}),
        ...(method.crypto_networks ? {
          cryptoNetworks: method.crypto_networks.map((network) => ({
            network: network.network,
            name: network.name,
            assets: network.assets,
            requiredConfirmations: network.required_confirmations,
          })),
        } : {}),
      })),
    };
  }

  public async quoteTopUp(
    telegramId: string,
    amount: number,
    paymentMethod: 'alipay' | 'wxpay' | 'crypto',
    crypto?: { asset: CryptoAsset; network: CryptoNetwork },
  ): Promise<TopUpQuote> {
    this.requireBridge('quoteTopUp');
    const payload = await this.request('/api/integrations/telegram/v1/topup/quote', {
      method: 'POST',
      body: { telegram_id: telegramId, amount, payment_method: paymentMethod, ...(crypto ? { crypto_asset: crypto.asset, crypto_network: crypto.network } : {}) },
    });
    const parsed = topUpQuoteSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api topup quote response changed');
    return {
      topupAmount: parsed.data.topup_amount,
      paymentMethod: parsed.data.payment_method,
      payableAmount: parsed.data.payable_amount,
      expiresIn: parsed.data.expires_in,
      ...(parsed.data.crypto_asset ? { cryptoAsset: parsed.data.crypto_asset } : {}),
      ...(parsed.data.crypto_network ? { cryptoNetwork: parsed.data.crypto_network } : {}),
    };
  }

  public async createTopUp(
    telegramId: string,
    amount: number,
    paymentMethod: 'alipay' | 'wxpay' | 'crypto',
    idempotencyKey: string,
    crypto?: { asset: CryptoAsset; network: CryptoNetwork },
  ): Promise<TopUpOrder> {
    this.requireBridge('createTopUp');
    const payload = await this.request('/api/integrations/telegram/v1/topup/orders', {
      method: 'POST',
      body: {
        telegram_id: telegramId,
        amount,
        payment_method: paymentMethod,
        idempotency_key: idempotencyKey,
        ...(crypto ? { crypto_asset: crypto.asset, crypto_network: crypto.network } : {}),
      },
    });
    const parsed = topUpOrderSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api topup order response changed');
    return {
      orderRef: parsed.data.order_ref,
      status: parsed.data.status,
      topupAmount: parsed.data.topup_amount,
      paymentMethod: parsed.data.payment_method,
      payableAmount: parsed.data.payable_amount,
      ...(parsed.data.checkout_url ? { checkoutUrl: parsed.data.checkout_url } : {}),
      ...(parsed.data.crypto_asset ? { cryptoAsset: parsed.data.crypto_asset } : {}),
      ...(parsed.data.crypto_network ? { cryptoNetwork: parsed.data.crypto_network } : {}),
      ...(parsed.data.deposit_address ? { depositAddress: parsed.data.deposit_address } : {}),
      ...(parsed.data.deposit_memo ? { depositMemo: parsed.data.deposit_memo } : {}),
      ...(parsed.data.required_confirmations ? { requiredConfirmations: parsed.data.required_confirmations } : {}),
      expiresAt: parsed.data.expires_at,
    };
  }

  public async getTopUpStatus(telegramId: string, orderRef: string): Promise<TopUpStatus> {
    this.requireBridge('getTopUpStatus');
    const payload = await this.request('/api/integrations/telegram/v1/topup/status', {
      method: 'POST',
      body: { telegram_id: telegramId, order_ref: orderRef },
    });
    const parsed = topUpStatusSchema.safeParse(unwrapData(payload));
    if (!parsed.success) throw new NewApiError('contract', 'new-api topup status response changed');
    return {
      orderRef: parsed.data.order_ref,
      status: parsed.data.status,
      paymentMethod: parsed.data.payment_method,
      payableAmount: parsed.data.payable_amount,
      ...(parsed.data.crypto_asset ? { cryptoAsset: parsed.data.crypto_asset } : {}),
      ...(parsed.data.crypto_network ? { cryptoNetwork: parsed.data.crypto_network } : {}),
      ...(parsed.data.required_confirmations ? { requiredConfirmations: parsed.data.required_confirmations } : {}),
      createdAt: parsed.data.created_at,
      ...(parsed.data.completed_at && parsed.data.completed_at > 0 ? { completedAt: parsed.data.completed_at } : {}),
      expiresAt: parsed.data.expires_at,
    };
  }

  private parseAccount(value: unknown): NewApiAccount {
    const parsed = accountSchema.safeParse(value);
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues }, 'new-api account contract mismatch');
      throw new NewApiError('contract', 'new-api account response changed');
    }
    return mapAccount(parsed.data);
  }

  private parseApiKey(value: unknown): ApiKey {
    const parsed = apiKeySchema.safeParse(value);
    if (!parsed.success) throw new NewApiError('contract', 'new-api api key response changed');
    return mapApiKey(parsed.data);
  }

  private requireBridge(operation: string): void {
    if (this.config.newApiIntegrationMode !== 'bridge') {
      throw new NewApiError('config', `${operation} requires bridge integration mode`);
    }
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

  private async request(
    path: string,
    options: { method?: string; body?: unknown; authenticated?: boolean } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.newApiRequestTimeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    if (options.authenticated !== false && this.config.newApiIntegrationMode === 'admin' && this.config.newApiAdminPat) {
      headers.Authorization = `Bearer ${this.config.newApiAdminPat}`;
    }
    if (options.authenticated !== false && this.config.newApiIntegrationMode === 'bridge' && this.config.newApiIntegrationSecret) {
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

function mapApiKey(input: z.infer<typeof apiKeySchema>): ApiKey {
  return {
    id: input.id,
    name: input.name,
    maskedKey: input.masked_key,
    status: input.status,
    group: input.group,
    ...(input.auto_groups ? { autoGroups: input.auto_groups } : {}),
    createdAt: input.created_at,
    expiresAt: input.expires_at,
  };
}

function cryptoRandomNonce(): string {
  return randomBytes(16).toString('hex');
}
