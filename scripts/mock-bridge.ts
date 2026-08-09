import Fastify from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

type CryptoAsset = 'USDT' | 'USDC';
type CryptoNetwork = 'bsc' | 'ethereum' | 'base' | 'solana';

type MockOrder = {
  orderRef: string;
  telegramId: string;
  amount: number;
  paymentMethod: 'alipay' | 'wxpay' | 'crypto';
  payableAmount: string;
  createdAt: number;
  expiresAt: number;
  statusChecks: number;
  cryptoAsset?: CryptoAsset;
  cryptoNetwork?: CryptoNetwork;
};

type MockApiKey = {
  id: number;
  telegramId: string;
  name: string;
  maskedKey: string;
  status: 'enabled' | 'disabled';
  group: string;
  autoGroups?: string[];
  createdAt: number;
  expiresAt: number;
};

const port = Number(process.env.MOCK_BRIDGE_PORT ?? 19191);
const server = Fastify({ logger: true });
const integrationSecret = process.env.MOCK_BRIDGE_SECRET ?? 'integration-secret-123456';
const claimedNonces = new Map<string, number>();
const orders = new Map<string, MockOrder>();
const orderByIdempotencyKey = new Map<string, string>();
const apiKeys = new Map<number, MockApiKey>();
const apiKeyByIdempotencyKey = new Map<string, number>();

server.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
  try {
    (request as typeof request & { rawBody?: string }).rawBody = body;
    done(null, JSON.parse(body));
  } catch (error) {
    done(error as Error, undefined);
  }
});

server.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/integrations/telegram/v1/')) return;
  const timestamp = String(request.headers['x-integration-timestamp'] ?? '').trim();
  const nonce = String(request.headers['x-integration-nonce'] ?? '').trim();
  const signature = String(request.headers['x-integration-signature'] ?? '').trim();
  const timestampSeconds = Number(timestamp);
  const rawBody = (request as typeof request & { rawBody?: string }).rawBody ?? '';
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(now - timestampSeconds) > 300 || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return reply.code(401).send(failure('integration unauthorized'));
  }
  for (const [value, expiresAt] of claimedNonces) {
    if (expiresAt <= now) claimedNonces.delete(value);
  }
  if (claimedNonces.has(nonce)) return reply.code(401).send(failure('integration replay rejected'));
  const path = new URL(request.url, 'http://mock-bridge.local').pathname;
  const canonical = [
    request.method,
    path,
    createHash('sha256').update(rawBody).digest('hex'),
    timestamp,
    nonce,
  ].join('\n');
  const expected = createHmac('sha256', integrationSecret).update(canonical).digest('hex');
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
    return reply.code(401).send(failure('integration unauthorized'));
  }
  claimedNonces.set(nonce, now + 600);
});

const apiKeyProfiles = [
  { id: 'auto', label: 'Automatic routing', auto_groups: ['default', 'pro'] },
  { id: 'default', label: 'Default' },
  { id: 'pro', label: 'Pro' },
] as const;

const cryptoNetworks = [
  { network: 'bsc', name: 'BNB Smart Chain (BEP-20)', assets: ['USDT', 'USDC'], required_confirmations: 12 },
  { network: 'ethereum', name: 'Ethereum (ERC-20)', assets: ['USDT', 'USDC'], required_confirmations: 12 },
  { network: 'base', name: 'Base', assets: ['USDT', 'USDC'], required_confirmations: 12 },
  { network: 'solana', name: 'Solana', assets: ['USDT', 'USDC'], required_confirmations: 32 },
] as const;

// Snapshot of SuperToken's public pricing catalog on 2026-08-09. This powers
// the local mock only; production always reads the bound user's enabled models
// from new-api rather than treating this fixture as an allow-list.
const mockModels = [
  { id: 'gpt-5.4', endpoint_types: ['openai'] },
  { id: 'gpt-5.4-mini', endpoint_types: ['openai'] },
  { id: 'gpt-5.5', endpoint_types: ['openai'] },
  { id: 'gpt-5.5-openai-compact', endpoint_types: ['openai'] },
  { id: 'gpt-5.6-luna', endpoint_types: ['openai'] },
  { id: 'gpt-5.6-sol', endpoint_types: ['openai'] },
  { id: 'gpt-5.6-terra', endpoint_types: ['openai'] },
  { id: 'gateway-oai-5.4', endpoint_types: ['openai'] },
  { id: 'gateway-oai-5.4-high', endpoint_types: ['openai'] },
  { id: 'gateway-oai-5.4-xhigh', endpoint_types: ['openai'] },
  { id: 'gateway-oai-5.5', endpoint_types: ['openai'] },
  { id: 'gateway-oai-5.5-high', endpoint_types: ['openai'] },
  { id: 'gateway-oai-5.5-xhigh', endpoint_types: ['openai'] },
  { id: 'codex-auto-review', endpoint_types: ['openai'] },
  { id: 'claude-fable-5', endpoint_types: ['anthropic', 'openai'] },
  { id: 'claude-haiku-4-5', endpoint_types: ['anthropic', 'openai'] },
  { id: 'claude-haiku-4-5-20251001', endpoint_types: ['anthropic', 'openai'] },
  { id: 'claude-opus-4-6', endpoint_types: ['anthropic', 'openai'] },
  { id: 'claude-opus-4-6-thinking', endpoint_types: ['anthropic', 'openai'] },
  { id: 'claude-opus-4-7', endpoint_types: ['anthropic', 'openai'] },
  { id: 'claude-opus-4-8', endpoint_types: ['anthropic', 'openai'] },
  { id: 'claude-opus-5', endpoint_types: ['anthropic', 'openai'] },
  { id: 'claude-sonnet-4-6', endpoint_types: ['anthropic', 'openai'] },
  { id: 'claude-sonnet-5', endpoint_types: ['anthropic', 'openai'] },
  { id: 'gemini-3.1-flash-lite', endpoint_types: ['gemini', 'openai'] },
  { id: 'gemini-3.1-pro', endpoint_types: ['gemini', 'openai'] },
  { id: 'gemini-3.1-pro-preview', endpoint_types: ['gemini', 'openai'] },
  { id: 'gemini-3.1-pro-preview-high', endpoint_types: ['gemini', 'openai'] },
  { id: 'gemini-3.5-flash', endpoint_types: ['gemini', 'openai'] },
  { id: 'gemini-3.6-flash', endpoint_types: ['gemini', 'openai'] },
  { id: 'grok-4.5', endpoint_types: ['openai', 'openai-response'] },
  { id: 'adobe-gpt-image-2', endpoint_types: ['image-generation', 'openai'] },
  { id: 'adobe-gpt-image-2-count', endpoint_types: ['image-generation', 'openai'] },
  { id: 'azure-gpt-image-2', endpoint_types: ['image-generation', 'openai'] },
  { id: 'gpt-image-2', endpoint_types: ['image-generation', 'openai'] },
  { id: 'gpt-image-2-count', endpoint_types: ['image-generation', 'openai'] },
  { id: 'gemini-3-pro-image', endpoint_types: ['image-generation', 'gemini', 'openai'] },
  { id: 'gemini-3-pro-image-count', endpoint_types: ['image-generation', 'gemini', 'openai'] },
  { id: 'gemini-3-pro-image-preview', endpoint_types: ['image-generation', 'gemini', 'openai'] },
  { id: 'gemini-3.1-flash-image', endpoint_types: ['image-generation', 'gemini', 'openai'] },
  { id: 'gemini-3.1-flash-image-count', endpoint_types: ['image-generation', 'gemini', 'openai'] },
  { id: 'gemini-3.1-flash-image-preview', endpoint_types: ['image-generation', 'gemini', 'openai'] },
  { id: 'grok-imagine-image-quality-720p', endpoint_types: ['image-generation', 'openai', 'openai-response'] },
  { id: 'seedance-2.0-720p-count', endpoint_types: ['openai'] },
  { id: 'grok-imagine-video-1.5-720p', endpoint_types: ['openai', 'openai-response'] },
  { id: 'adobe-kling-3.0-720p', endpoint_types: ['video-task'] },
  { id: 'adobe-kling-3.0-1080p', endpoint_types: ['video-task'] },
  { id: 'adobe-kling-3.0-omni-720p', endpoint_types: ['video-task'] },
  { id: 'adobe-kling-3.0-omni-1080p', endpoint_types: ['video-task'] },
  { id: 'adobe-seedance-2.0-480p', endpoint_types: ['video-task'] },
  { id: 'adobe-seedance-2.0-720p', endpoint_types: ['video-task'] },
  { id: 'adobe-seedance-2.0-1080p', endpoint_types: ['video-task'] },
  { id: 'adobe-seedance-2.0-fast-480p', endpoint_types: ['video-task'] },
  { id: 'adobe-seedance-2.0-fast-720p', endpoint_types: ['video-task'] },
  { id: 'adobe-veo-3.1-fast-720p', endpoint_types: ['video-task'] },
  { id: 'adobe-veo-3.1-720p', endpoint_types: ['video-task'] },
  { id: 'adobe-veo-3.1-1080p', endpoint_types: ['video-task'] },
  { id: 'leonardo-minimax-h3-1440p', endpoint_types: ['video-task'] },
  { id: 'leonardo-seedance-2.0-480p', endpoint_types: ['video-task'] },
  { id: 'leonardo-seedance-2.0-720p', endpoint_types: ['video-task'] },
  { id: 'leonardo-seedance-2.0-1080p', endpoint_types: ['video-task'] },
  { id: 'leonardo-seedance-2.0-fast-480p', endpoint_types: ['video-task'] },
  { id: 'leonardo-seedance-2.0-fast-720p', endpoint_types: ['video-task'] },
] as const;

function success(data: unknown) {
  return { success: true, message: '', data };
}

function failure(message: string) {
  return { success: false, message };
}

function stringField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function numericField(body: unknown, key: string): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function booleanField(body: unknown, key: string): boolean | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function requireBound(body: unknown) {
  const telegramId = stringField(body, 'telegram_id');
  return telegramId && telegramId !== 'unbound' ? telegramId : undefined;
}

function mockAddress(network: CryptoNetwork): string {
  const addresses: Record<CryptoNetwork, string> = {
    bsc: '0x1111111111111111111111111111111111111111',
    ethereum: '0x2222222222222222222222222222222222222222',
    base: '0x3333333333333333333333333333333333333333',
    solana: 'So11111111111111111111111111111111111111112',
  };
  return addresses[network];
}

server.get('/api/status', async () => success({ quota_per_unit: 500000, quota_display_type: 'USD', system_name: 'SuperToken Mock' }));
server.get('/api/notice', async () => success([
  'SuperToken Mock 公告',
  '',
  '当前为本机验收环境：账户、订阅、订单和到账状态均为模拟数据。',
  '易支付二维码仅打开本机 checkout 页面，链上地址不会接收真实资金。',
  '生产支付、额度入账和客服工单请始终以 new-api 网页与运营流程为准。',
].join('\n')));

server.post('/api/integrations/telegram/v1/account/summary', async (request) => {
  const telegramId = requireBound(request.body);
  if (!telegramId) return failure('telegram account is not bound');
  return success({
    id: 42,
    username: 'mock-user',
    display_name: 'Mock User',
    telegram_id: telegramId,
    status: 1,
    group: 'pro',
    quota: 125000000,
    used_quota: 43750000,
    request_count: 1848,
  });
});

server.post('/api/integrations/telegram/v1/account/usage', async (request) => {
  if (!requireBound(request.body)) return failure('telegram account is not bound');
  const startTimestamp = numericField(request.body, 'start_timestamp');
  const endTimestamp = numericField(request.body, 'end_timestamp');
  const rangeSeconds = startTimestamp && endTimestamp ? Math.max(0, endTimestamp - startTimestamp) : 0;
  if (rangeSeconds > 21 * 24 * 60 * 60) return success({ quota: 54600000, rpm: 67, tpm: 119800 });
  if (rangeSeconds > 24 * 60 * 60) return success({ quota: 17400000, rpm: 43, tpm: 74200 });
  return success({ quota: 2450000, rpm: 21, tpm: 40800 });
});

server.post('/api/integrations/telegram/v1/account/subscriptions', async (request) => {
  if (!requireBound(request.body)) return failure('telegram account is not bound');
  const now = Math.floor(Date.now() / 1000);
  return success([
    {
      subscription: {
        id: 9001,
        plan_id: 88,
        status: 'active',
        start_time: now - 14 * 24 * 60 * 60,
        end_time: now + 17 * 24 * 60 * 60,
        amount_total: 75000000,
        amount_used: 28000000,
      },
    },
    {
      subscription: {
        id: 8993,
        plan_id: 66,
        status: 'expired',
        start_time: now - 75 * 24 * 60 * 60,
        end_time: now - 15 * 24 * 60 * 60,
        amount_total: 50000000,
        amount_used: 50000000,
      },
    },
  ]);
});

server.post('/api/integrations/telegram/v1/models', async (request) => {
  if (!requireBound(request.body)) return failure('telegram account is not bound');
  const cursor = Number(stringField(request.body, 'cursor') ?? '0');
  if (!Number.isSafeInteger(cursor) || cursor < 0) return failure('invalid model cursor');
  const pageSize = 12;
  const page = mockModels.slice(cursor, cursor + pageSize);
  const next = cursor + page.length;
  return success({ models: page, total: mockModels.length, ...(next < mockModels.length ? { next_cursor: String(next) } : {}) });
});

server.post('/api/integrations/telegram/v1/api-access', async (request) => {
  if (!requireBound(request.body)) return failure('telegram account is not bound');
  return success({
    base_url: 'https://supertoken.cc/v1',
    key_management_url: 'https://supertoken.cc/keys',
    profiles: apiKeyProfiles,
    key_limit: 5,
  });
});

server.post('/api/integrations/telegram/v1/keys', async (request) => {
  const telegramId = requireBound(request.body);
  if (!telegramId) return failure('telegram account is not bound');
  const keys = [...apiKeys.values()]
    .filter((key) => key.telegramId === telegramId)
    .sort((left, right) => right.id - left.id)
    .map(renderApiKey);
  return success({ keys });
});

server.post('/api/integrations/telegram/v1/keys/create', async (request) => {
  const telegramId = requireBound(request.body);
  const profileIndex = numericField(request.body, 'profile_index');
  const idempotencyKey = stringField(request.body, 'idempotency_key');
  if (!telegramId || profileIndex === undefined || profileIndex < 0 || profileIndex >= apiKeyProfiles.length
    || !idempotencyKey || !/^[A-Za-z0-9_-]{1,64}$/.test(idempotencyKey)) {
    return failure('invalid key request');
  }
  const requestKey = `${telegramId}:${idempotencyKey}`;
  const existingId = apiKeyByIdempotencyKey.get(requestKey);
  const existing = existingId ? apiKeys.get(existingId) : undefined;
  if (existing) return success(renderApiKey(existing));

  const profile = apiKeyProfiles[profileIndex];
  if (!profile) return failure('invalid key request');
  const id = apiKeys.size + 1;
  const now = Math.floor(Date.now() / 1000);
  const key: MockApiKey = {
    id,
    telegramId,
    name: `Telegram ${idempotencyKey.slice(0, 18)}`,
    maskedKey: `sk-m**********${String(id).padStart(4, '0')}`,
    status: 'enabled',
    group: profile.id,
    ...(profile.auto_groups ? { autoGroups: [...profile.auto_groups] } : {}),
    createdAt: now,
    expiresAt: now + 90 * 24 * 60 * 60,
  };
  apiKeys.set(id, key);
  apiKeyByIdempotencyKey.set(requestKey, id);
  return success(renderApiKey(key));
});

server.post('/api/integrations/telegram/v1/keys/status', async (request) => {
  const telegramId = requireBound(request.body);
  const tokenId = numericField(request.body, 'token_id');
  const enabled = booleanField(request.body, 'enabled');
  const key = tokenId === undefined ? undefined : apiKeys.get(tokenId);
  if (!telegramId || enabled === undefined || !key || key.telegramId !== telegramId) return failure('api key is not available');
  key.status = enabled ? 'enabled' : 'disabled';
  return success(renderApiKey(key));
});

server.post('/api/integrations/telegram/v1/keys/delete', async (request) => {
  const telegramId = requireBound(request.body);
  const tokenId = numericField(request.body, 'token_id');
  const key = tokenId === undefined ? undefined : apiKeys.get(tokenId);
  if (!telegramId || !key || key.telegramId !== telegramId) return failure('api key is not available');
  apiKeys.delete(key.id);
  return success({ deleted: true });
});

server.post('/api/integrations/telegram/v1/topup/options', async (request) => {
  if (!requireBound(request.body)) return failure('telegram account is not bound');
  return success({
    enabled: true,
    display_type: 'USD',
    min_topup: 50,
    amount_options: [50, 100, 200, 500, 1000],
    payment_methods: [
      { type: 'alipay', name: '支付宝' },
      { type: 'wxpay', name: '微信支付', min_topup: 20 },
      { type: 'crypto', name: 'USDT / USDC', crypto_networks: cryptoNetworks },
    ],
  });
});

server.post('/api/integrations/telegram/v1/topup/quote', async (request) => {
  if (!requireBound(request.body)) return failure('telegram account is not bound');
  const amount = numericField(request.body, 'amount');
  const paymentMethod = stringField(request.body, 'payment_method');
  if (!amount || amount < 50 || !['alipay', 'wxpay', 'crypto'].includes(paymentMethod ?? '')) return failure('invalid topup request');
  if (paymentMethod !== 'crypto') {
    return success({ topup_amount: amount, payment_method: paymentMethod, payable_amount: amount.toFixed(2), expires_in: 900 });
  }
  const asset = stringField(request.body, 'crypto_asset') as CryptoAsset | undefined;
  const network = stringField(request.body, 'crypto_network') as CryptoNetwork | undefined;
  const networkConfig = cryptoNetworks.find((candidate) => candidate.network === network && asset && candidate.assets.includes(asset));
  if (!asset || !network || !networkConfig) return failure('invalid crypto network');
  return success({
    topup_amount: amount,
    payment_method: 'crypto',
    payable_amount: (amount + 0.01).toFixed(6),
    expires_in: 900,
    crypto_asset: asset,
    crypto_network: network,
  });
});

server.post('/api/integrations/telegram/v1/topup/orders', async (request) => {
  const telegramId = requireBound(request.body);
  const amount = numericField(request.body, 'amount');
  const paymentMethod = stringField(request.body, 'payment_method') as MockOrder['paymentMethod'] | undefined;
  const idempotencyKey = stringField(request.body, 'idempotency_key');
  if (!telegramId || !amount || amount < 50 || !paymentMethod || !['alipay', 'wxpay', 'crypto'].includes(paymentMethod) || !idempotencyKey) {
    return failure('invalid topup request');
  }
  const existingRef = orderByIdempotencyKey.get(idempotencyKey);
  const existing = existingRef ? orders.get(existingRef) : undefined;
  if (existing) {
    if (existing.telegramId !== telegramId) return failure('topup request conflicts with an existing payment order');
    return success(renderOrder(existing));
  }

  const now = Math.floor(Date.now() / 1000);
  const cryptoAsset = stringField(request.body, 'crypto_asset') as CryptoAsset | undefined;
  const cryptoNetwork = stringField(request.body, 'crypto_network') as CryptoNetwork | undefined;
  const networkConfig = cryptoNetworks.find((candidate) => candidate.network === cryptoNetwork && cryptoAsset && candidate.assets.includes(cryptoAsset));
  if (paymentMethod === 'crypto' && (!cryptoAsset || !cryptoNetwork || !networkConfig)) return failure('invalid crypto network');
  const order: MockOrder = {
    orderRef: `MOCKTG${orders.size + 1}`,
    telegramId,
    amount,
    paymentMethod,
    payableAmount: paymentMethod === 'crypto' ? (amount + 0.01).toFixed(6) : amount.toFixed(2),
    createdAt: now,
    expiresAt: now + 900,
    statusChecks: 0,
    ...(paymentMethod === 'crypto' ? { cryptoAsset, cryptoNetwork } : {}),
  };
  orders.set(order.orderRef, order);
  orderByIdempotencyKey.set(idempotencyKey, order.orderRef);
  return success(renderOrder(order));
});

server.post('/api/integrations/telegram/v1/topup/status', async (request) => {
  const telegramId = requireBound(request.body);
  const orderRef = stringField(request.body, 'order_ref');
  const order = orderRef ? orders.get(orderRef) : undefined;
  if (!telegramId || !order || order.telegramId !== telegramId) return failure('topup order is not available');
  order.statusChecks += 1;
  const status = order.statusChecks === 1 ? 'processing' : 'success';
  return success({
    order_ref: order.orderRef,
    status,
    payment_method: order.paymentMethod,
    payable_amount: order.payableAmount,
    created_at: order.createdAt,
    ...(status === 'success' ? { completed_at: Math.floor(Date.now() / 1000) } : {}),
    expires_at: order.expiresAt,
    ...(order.paymentMethod === 'crypto' ? {
      crypto_asset: order.cryptoAsset,
      crypto_network: order.cryptoNetwork,
      required_confirmations: cryptoNetworks.find((network) => network.network === order.cryptoNetwork)?.required_confirmations,
    } : {}),
  });
});

server.get('/mock-checkout/:orderRef', async (request, reply) => {
  const order = orders.get((request.params as { orderRef: string }).orderRef);
  if (!order) return reply.code(404).type('text/plain').send('Mock order not found');
  return reply.type('text/html').send('<!doctype html><title>Mock checkout</title><p>This is a mock checkout. No payment is accepted.</p>');
});

function renderOrder(order: MockOrder) {
  if (order.paymentMethod !== 'crypto') {
    return {
      order_ref: order.orderRef,
      status: 'pending',
      topup_amount: order.amount,
      payment_method: order.paymentMethod,
      payable_amount: order.payableAmount,
      checkout_url: `http://127.0.0.1:${port}/mock-checkout/${order.orderRef}`,
      expires_at: order.expiresAt,
    };
  }
  const network = cryptoNetworks.find((candidate) => candidate.network === order.cryptoNetwork);
  return {
    order_ref: order.orderRef,
    status: 'pending',
    topup_amount: order.amount,
    payment_method: 'crypto',
    payable_amount: order.payableAmount,
    crypto_asset: order.cryptoAsset,
    crypto_network: order.cryptoNetwork,
    deposit_address: mockAddress(order.cryptoNetwork as CryptoNetwork),
    required_confirmations: network?.required_confirmations,
    expires_at: order.expiresAt,
  };
}

function renderApiKey(key: MockApiKey) {
  return {
    id: key.id,
    name: key.name,
    masked_key: key.maskedKey,
    status: key.status,
    group: key.group,
    ...(key.autoGroups ? { auto_groups: key.autoGroups } : {}),
    created_at: key.createdAt,
    expires_at: key.expiresAt,
  };
}

await server.listen({ host: '127.0.0.1', port });
