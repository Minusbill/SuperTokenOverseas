import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { NewApiClient, NewApiError } from '../../src/new-api.js';

const logger = pino({ enabled: false });
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

type RequestHandler = (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void;

async function startServer(handler: RequestHandler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function config(baseUrl: string, mode: 'admin' | 'bridge' = 'bridge'): Config {
  return loadConfig({
    NODE_ENV: 'test',
    BOT_MODE: 'polling',
    TELEGRAM_BOT_TOKEN: 'test-token',
    NEW_API_BASE_URL: baseUrl,
    NEW_API_INTEGRATION_MODE: mode,
    NEW_API_ADMIN_PAT: mode === 'admin' ? 'admin-pat' : undefined,
    NEW_API_INTEGRATION_SECRET: mode === 'bridge' ? 'integration-secret-123456' : undefined,
  });
}

function assertBridgeSignature(request: IncomingMessage, body: string): void {
  const timestamp = String(request.headers['x-integration-timestamp'] ?? '');
  const nonce = String(request.headers['x-integration-nonce'] ?? '');
  const signature = String(request.headers['x-integration-signature'] ?? '');
  const canonical = [
    request.method,
    new URL(request.url ?? '/', 'http://new-api.test').pathname,
    createHash('sha256').update(body).digest('hex'),
    timestamp,
    nonce,
  ].join('\n');
  expect(signature).toBe(createHmac('sha256', 'integration-secret-123456').update(canonical).digest('hex'));
}

describe('NewApiClient', () => {
  it('unwraps a successful bridge account response and signs the request', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody = '';
    const baseUrl = await startServer((request, response) => {
      receivedHeaders = request.headers;
      request.setEncoding('utf8');
      request.on('data', (chunk: Buffer | string) => { receivedBody += chunk.toString(); });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          success: true,
          data: {
            id: 42,
            username: 'alice',
            telegram_id: '1001',
            status: 1,
            quota: 500000,
            used_quota: 1000,
          },
        }));
      });
    });

    const account = await new NewApiClient(config(baseUrl), logger).resolveAccountByTelegramId('1001');
    expect(account).toMatchObject({ id: 42, username: 'alice', telegramId: '1001' });
    expect(receivedBody).toBe('{"telegram_id":"1001"}');
    expect(receivedHeaders['x-integration-signature']).toEqual(expect.any(String));
    expect(receivedHeaders['x-integration-nonce']).toEqual(expect.any(String));
    expect(receivedHeaders['x-integration-timestamp']).toEqual(expect.any(String));
  });

  it('turns HTTP 200 success:false into an API error', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: false, message: 'telegram account is not bound' }));
    });

    await expect(new NewApiClient(config(baseUrl), logger).resolveAccountByTelegramId('1001'))
      .rejects.toMatchObject({ code: 'api' } satisfies Partial<NewApiError>);
  });

  it('rejects an unknown quota display type instead of guessing the currency', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        data: { quota_per_unit: 500000, quota_display_type: 'EUR' },
      }));
    });

    await expect(new NewApiClient(config(baseUrl), logger).getStatus())
      .rejects.toMatchObject({ code: 'contract' } satisfies Partial<NewApiError>);
  });

  it('reads the public model catalogue without leaking an admin PAT', async () => {
    let authorization: string | undefined;
    const baseUrl = await startServer((request, response) => {
      authorization = request.headers.authorization;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        data: [
          {
            model_name: 'gpt-5.6-sol', supported_endpoint_types: ['openai'], quota_type: 0,
            model_ratio: 0.625, completion_ratio: 8, enable_groups: ['default'],
          },
          {
            model_name: 'claude-opus-5', supported_endpoint_types: ['anthropic', 'openai'], quota_type: 1,
            model_price: 0.05, enable_groups: ['default'],
          },
          {
            model_name: 'veo-3', quota_type: 0, model_ratio: 1, completion_ratio: 1,
            billing_mode: 'tiered_expr', billing_expr: 'inputPrice=1', enable_groups: ['default'],
          },
        ],
        group_ratio: { default: 0.8 },
      }));
    });

    const models = await new NewApiClient(config(baseUrl, 'admin'), logger).getPublicModels();
    expect(models.total).toBe(3);
    expect(models.models[0]).toEqual({
      id: 'gpt-5.6-sol', endpointTypes: ['openai'],
      cataloguePrice: { kind: 'token', inputUsdPerMillion: 1, outputUsdPerMillion: 8 },
    });
    expect(models.models[1]?.cataloguePrice).toMatchObject({ kind: 'request' });
    expect(models.models[1]?.cataloguePrice?.kind === 'request'
      ? models.models[1].cataloguePrice.usdPerRequest
      : undefined).toBeCloseTo(0.04, 12);
    expect(models.models[2]?.cataloguePrice).toEqual({ kind: 'dynamic' });
    expect(authorization).toBeUndefined();
  });

  it('accepts the SubscriptionSummary wrapper returned by new-api', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        data: [{
          subscription: {
            id: 9,
            plan_id: 3,
            status: 'active',
            start_time: 1,
            end_time: 2,
            amount_total: 100,
            amount_used: 20,
          },
        }],
      }));
    });

    const subscriptions = await new NewApiClient(config(baseUrl), logger).getSubscriptions({
      id: 42,
      username: 'alice',
      telegramId: '1001',
      status: 1,
      quota: 0,
      usedQuota: 0,
    });
    expect(subscriptions[0]).toMatchObject({ id: 9, planId: 3, amount: 100, usedAmount: 20, remainingAmount: 80 });
  });

  it('uses the scoped Bridge contract for topup options, quote, order, and status', async () => {
    const received: Array<{ path: string; body: string }> = [];
    const baseUrl = await startServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        assertBridgeSignature(request, body);
        const path = new URL(request.url ?? '/', 'http://new-api.test').pathname;
        received.push({ path, body });
        response.setHeader('content-type', 'application/json');
        if (path.endsWith('/options')) {
          response.end(JSON.stringify({ success: true, data: {
            enabled: true, display_type: 'USD', min_topup: 10, amount_options: [10, 20],
            payment_methods: [{ type: 'alipay', name: '支付宝' }, { type: 'wxpay', name: '微信支付', min_topup: '20' }],
          } }));
          return;
        }
        if (path.endsWith('/quote')) {
          response.end(JSON.stringify({ success: true, data: {
            topup_amount: 10, payment_method: 'alipay', payable_amount: '73.00', expires_in: 900,
          } }));
          return;
        }
        if (path.endsWith('/orders')) {
          response.end(JSON.stringify({ success: true, data: {
            order_ref: 'TGUSR42NO1234567890', status: 'pending', topup_amount: 10, payment_method: 'alipay',
            payable_amount: '73.00', checkout_url: 'https://new-api.example.test/api/integrations/telegram/v1/checkout/signed-token',
            expires_at: 1_800_000_000,
          } }));
          return;
        }
        response.end(JSON.stringify({ success: true, data: {
          order_ref: 'TGUSR42NO1234567890', status: 'success', payment_method: 'alipay', payable_amount: '73.00',
          created_at: 1_700_000_000, completed_at: 1_700_000_100, expires_at: 1_800_000_000,
        } }));
      });
    });
    const client = new NewApiClient(config(baseUrl), logger);

    await expect(client.getTopUpOptions('1001')).resolves.toMatchObject({
      enabled: true, minTopup: 10, paymentMethods: [{ type: 'alipay' }, { type: 'wxpay', minTopup: 20 }],
    });
    await expect(client.quoteTopUp('1001', 10, 'alipay')).resolves.toMatchObject({ payableAmount: '73.00' });
    await expect(client.createTopUp('1001', 10, 'alipay', 'callback-123')).resolves.toMatchObject({
      orderRef: 'TGUSR42NO1234567890', status: 'pending', checkoutUrl: expect.stringContaining('/checkout/'),
    });
    await expect(client.getTopUpStatus('1001', 'TGUSR42NO1234567890')).resolves.toMatchObject({
      status: 'success', completedAt: 1_700_000_100,
    });

    expect(received).toEqual([
      { path: '/api/integrations/telegram/v1/topup/options', body: '{"telegram_id":"1001"}' },
      { path: '/api/integrations/telegram/v1/topup/quote', body: '{"telegram_id":"1001","amount":10,"payment_method":"alipay"}' },
      { path: '/api/integrations/telegram/v1/topup/orders', body: '{"telegram_id":"1001","amount":10,"payment_method":"alipay","idempotency_key":"callback-123"}' },
      { path: '/api/integrations/telegram/v1/topup/status', body: '{"telegram_id":"1001","order_ref":"TGUSR42NO1234567890"}' },
    ]);
  });

  it('normalizes a disabled Bridge payment method list serialized as null', async () => {
    const baseUrl = await startServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        assertBridgeSignature(request, body);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ success: true, data: {
          enabled: false, display_type: 'USD', min_topup: 1, amount_options: [10, 20], payment_methods: null,
        } }));
      });
    });

    await expect(new NewApiClient(config(baseUrl), logger).getTopUpOptions('1001')).resolves.toEqual({
      enabled: false,
      displayType: 'USD',
      minTopup: 1,
      amountOptions: [10, 20],
      paymentMethods: [],
    });
  });

  it('parses a paged model list and a multi-chain stablecoin order without relaxing fiat contracts', async () => {
    const received: Array<{ path: string; body: string }> = [];
    const baseUrl = await startServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        assertBridgeSignature(request, body);
        const path = new URL(request.url ?? '/', 'http://new-api.test').pathname;
        received.push({ path, body });
        response.setHeader('content-type', 'application/json');
        if (path.endsWith('/models')) {
          response.end(JSON.stringify({ success: true, data: {
            models: [{ id: 'gpt-5.6-terra', endpoint_types: ['openai'] }], total: 2, next_cursor: '1',
          } }));
          return;
        }
        if (path.endsWith('/options')) {
          response.end(JSON.stringify({ success: true, data: {
            enabled: true, display_type: 'USD', min_topup: 10, amount_options: [10],
            payment_methods: [{
              type: 'crypto', name: 'USDT / USDC', crypto_networks: [{
                network: 'base', name: 'Base', assets: ['USDC'], required_confirmations: 12,
              }],
            }],
          } }));
          return;
        }
        if (path.endsWith('/quote')) {
          response.end(JSON.stringify({ success: true, data: {
            topup_amount: 10, payment_method: 'crypto', payable_amount: '10.010000', expires_in: 900,
            crypto_asset: 'USDC', crypto_network: 'base',
          } }));
          return;
        }
        if (path.endsWith('/orders')) {
          response.end(JSON.stringify({ success: true, data: {
            order_ref: 'MOCKTG1', status: 'pending', topup_amount: 10, payment_method: 'crypto', payable_amount: '10.010000',
            crypto_asset: 'USDC', crypto_network: 'base', deposit_address: '0x3333333333333333333333333333333333333333',
            required_confirmations: 12, expires_at: 1_800_000_000,
          } }));
          return;
        }
        response.end(JSON.stringify({ success: true, data: {
          order_ref: 'MOCKTG1', status: 'processing', payment_method: 'crypto', payable_amount: '10.010000',
          crypto_asset: 'USDC', crypto_network: 'base', required_confirmations: 12,
          created_at: 1_700_000_000, expires_at: 1_800_000_000,
        } }));
      });
    });
    const client = new NewApiClient(config(baseUrl), logger);

    await expect(client.getAvailableModels('1001')).resolves.toMatchObject({ total: 2, nextCursor: '1', models: [{ id: 'gpt-5.6-terra' }] });
    await expect(client.getTopUpOptions('1001')).resolves.toMatchObject({
      paymentMethods: [{ type: 'crypto', cryptoNetworks: [{ network: 'base', assets: ['USDC'] }] }],
    });
    await expect(client.quoteTopUp('1001', 10, 'crypto', { asset: 'USDC', network: 'base' }))
      .resolves.toMatchObject({ payableAmount: '10.010000', cryptoAsset: 'USDC', cryptoNetwork: 'base' });
    await expect(client.createTopUp('1001', 10, 'crypto', 'crypto-callback-1', { asset: 'USDC', network: 'base' }))
      .resolves.toMatchObject({ depositAddress: '0x3333333333333333333333333333333333333333', requiredConfirmations: 12 });
    await expect(client.getTopUpStatus('1001', 'MOCKTG1')).resolves.toMatchObject({ status: 'processing', cryptoNetwork: 'base' });

    expect(received).toEqual([
      { path: '/api/integrations/telegram/v1/models', body: '{"telegram_id":"1001"}' },
      { path: '/api/integrations/telegram/v1/topup/options', body: '{"telegram_id":"1001"}' },
      { path: '/api/integrations/telegram/v1/topup/quote', body: '{"telegram_id":"1001","amount":10,"payment_method":"crypto","crypto_asset":"USDC","crypto_network":"base"}' },
      { path: '/api/integrations/telegram/v1/topup/orders', body: '{"telegram_id":"1001","amount":10,"payment_method":"crypto","idempotency_key":"crypto-callback-1","crypto_asset":"USDC","crypto_network":"base"}' },
      { path: '/api/integrations/telegram/v1/topup/status', body: '{"telegram_id":"1001","order_ref":"MOCKTG1"}' },
    ]);
  });

  it('uses scoped API access and key-management contracts without accepting an unmasked key', async () => {
    const received: Array<{ path: string; body: string }> = [];
    const baseUrl = await startServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        assertBridgeSignature(request, body);
        const path = new URL(request.url ?? '/', 'http://new-api.test').pathname;
        received.push({ path, body });
        response.setHeader('content-type', 'application/json');
        if (path.endsWith('/api-access')) {
          response.end(JSON.stringify({ success: true, data: {
            base_url: 'https://supertoken.example.test/v1', key_management_url: 'https://supertoken.example.test/keys',
            profiles: [{ id: 'auto', label: 'Auto', auto_groups: ['default', 'vip'] }, { id: 'vip', label: 'VIP' }], key_limit: 5,
          } }));
          return;
        }
        if (path.endsWith('/keys') && request.method === 'POST') {
          response.end(JSON.stringify({ success: true, data: { keys: [{
            id: 8, name: 'Telegram request-123', masked_key: 'sk-a**********z', status: 'enabled', group: 'vip',
            created_at: 1_700_000_000, expires_at: 1_800_000_000,
          }] } }));
          return;
        }
        if (path.endsWith('/keys/create') || path.endsWith('/keys/status')) {
          response.end(JSON.stringify({ success: true, data: {
            id: 8, name: 'Telegram request-123', masked_key: 'sk-a**********z', status: 'disabled', group: 'vip',
            created_at: 1_700_000_000, expires_at: 1_800_000_000,
          } }));
          return;
        }
        response.end(JSON.stringify({ success: true, data: { deleted: true } }));
      });
    });
    const client = new NewApiClient(config(baseUrl), logger);

    const apiAccess = await client.getApiAccess('1001');
    expect(apiAccess).toMatchObject({ baseUrl: 'https://supertoken.example.test/v1', keyLimit: 5 });
    expect(apiAccess.profiles[0]).toMatchObject({ id: 'auto', autoGroups: ['default', 'vip'] });
    await expect(client.listApiKeys('1001')).resolves.toMatchObject([{ id: 8, maskedKey: 'sk-a**********z', status: 'enabled' }]);
    await expect(client.createApiKey('1001', 1, 'request-123')).resolves.toMatchObject({ id: 8, status: 'disabled' });
    await expect(client.setApiKeyStatus('1001', 8, false)).resolves.toMatchObject({ id: 8, status: 'disabled' });
    await expect(client.deleteApiKey('1001', 8)).resolves.toBeUndefined();

    expect(received).toEqual([
      { path: '/api/integrations/telegram/v1/api-access', body: '{"telegram_id":"1001"}' },
      { path: '/api/integrations/telegram/v1/keys', body: '{"telegram_id":"1001"}' },
      { path: '/api/integrations/telegram/v1/keys/create', body: '{"telegram_id":"1001","profile_index":1,"idempotency_key":"request-123"}' },
      { path: '/api/integrations/telegram/v1/keys/status', body: '{"telegram_id":"1001","token_id":8,"enabled":false}' },
      { path: '/api/integrations/telegram/v1/keys/delete', body: '{"telegram_id":"1001","token_id":8}' },
    ]);
  });

  it('rejects malformed topup data and blocks topup endpoints in admin mode', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, data: {
        topup_amount: 10, payment_method: 'alipay', payable_amount: '73', expires_in: 900,
      } }));
    });

    await expect(new NewApiClient(config(baseUrl), logger).quoteTopUp('1001', 10, 'alipay'))
      .rejects.toMatchObject({ code: 'contract' } satisfies Partial<NewApiError>);
    await expect(new NewApiClient(config(baseUrl, 'admin'), logger).getTopUpOptions('1001'))
      .rejects.toMatchObject({ code: 'config' } satisfies Partial<NewApiError>);
  });

  it('rejects an API-key response that contains an unmasked key', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: true, data: {
        id: 8, name: 'Telegram request-123', masked_key: 'sk-live-sensitive-value', status: 'enabled', group: 'default',
        created_at: 1_700_000_000, expires_at: 1_800_000_000,
      } }));
    });

    await expect(new NewApiClient(config(baseUrl), logger).createApiKey('1001', 0, 'request-123'))
      .rejects.toMatchObject({ code: 'contract' } satisfies Partial<NewApiError>);
  });
});
