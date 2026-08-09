import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot.js';
import { loadConfig, type Config } from '../../src/config.js';
import { MemoryRepository } from '../../src/db.js';
import type { ApiAccess, ApiKey, NewApiAccount, NewApiStatus, TopUpOptions } from '../../src/types.js';

const account: NewApiAccount = {
  id: 42, username: 'alice', displayName: 'Alice', telegramId: '1001', status: 1,
  group: 'default', quota: 500000, usedQuota: 1000, requestCount: 3,
};
const status: NewApiStatus = { quotaPerUnit: 500000, quotaDisplayType: 'USD' };

function config(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test', BOT_MODE: 'polling', TELEGRAM_BOT_TOKEN: 'test-token',
    NEW_API_BASE_URL: 'https://new-api.example.test', NEW_API_INTEGRATION_MODE: 'bridge',
    NEW_API_INTEGRATION_SECRET: 'integration-secret-123456',
    ...overrides,
  });
}

function messageUpdate(updateId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1001, type: 'private' },
      from: { id: 1001, is_bot: false, first_name: 'Alice', language_code: 'zh' },
      text,
      entities: text.startsWith('/') ? [{ offset: 0, length: text.split(' ')[0]?.length ?? 0, type: 'bot_command' }] : [],
    },
  };
}

function callbackUpdate(updateId: number, callbackId: string, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: 1001, is_bot: false, first_name: 'Alice', language_code: 'zh' },
      chat_instance: 'test-chat-instance',
      data,
      message: {
        message_id: 99,
        date: 1,
        chat: { id: 1001, type: 'private' },
        from: { id: 9999, is_bot: true, first_name: 'Test', username: 'test_bot' },
        text: '菜单',
      },
    },
  };
}

describe('telegram bot commands', () => {
  it('binds through the Bridge and deduplicates a repeated update', async () => {
    const repository = new MemoryRepository();
    const sent: string[] = [];
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }),
      newApi: {
        getStatus: async () => status,
        resolveAccountByTelegramId: async () => account,
        getAccountById: async () => account,
        getUsage: async () => ({ quota: 1000, rpm: 1, tpm: 2 }),
        getSubscriptions: async () => [],
        getNotice: async () => '',
      } as never,
    });
    let nextMessageId = 100;
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 7847736904, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push(String((payload as { text?: string }).text ?? ''));
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: nextMessageId++, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(1, '/bind') as never);
    await bot.handleUpdate(messageUpdate(1, '/bind') as never);

    expect(await repository.getBinding('1001')).toMatchObject({ newApiUserId: 42, status: 'active' });
    expect(sent.filter((text) => text.includes('账号绑定成功'))).toHaveLength(1);
  });

  it('supports the usage range argument and rejects group account access', async () => {
    const repository = new MemoryRepository();
    const sent: string[] = [];
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }),
      newApi: {
        getStatus: async () => status,
        resolveAccountByTelegramId: async () => account,
        getAccountById: async () => account,
        getUsage: async (_account: NewApiAccount, start: number, end: number) => {
          expect(end - start).toBeGreaterThan(6 * 24 * 60 * 60);
          return { quota: 1000 };
        },
        getSubscriptions: async () => [],
        getNotice: async () => '',
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 7847736904, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push(String((payload as { text?: string }).text ?? ''));
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(2, '/usage 7d') as never);
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 3, date: 1, chat: { id: -9, type: 'group' }, from: { id: 1001, is_bot: false, first_name: 'Alice' }, text: '/account', entities: [{ offset: 0, length: 8, type: 'bot_command' }] },
    } as never);

    expect(sent.some((text) => text.includes('近 7 天用量'))).toBe(true);
    expect(sent.some((text) => text.includes('请在与机器人的私聊中'))).toBe(true);
  });

  it('uses only official public and portal capabilities in admin mode', async () => {
    const repository = new MemoryRepository();
    const sent: Array<{ text: string; payload: unknown }> = [];
    let publicModelCalls = 0;
    const bot = createBot({
      config: config({
        NEW_API_INTEGRATION_MODE: 'admin',
        NEW_API_ADMIN_PAT: 'admin-pat',
        NEW_API_PORTAL_URL: 'https://portal.example.test',
        NEW_API_PRICING_URL: 'https://portal.example.test/pricing',
        NEW_API_TOPUP_URL: 'https://portal.example.test/topup',
      }),
      repository,
      logger: pino({ enabled: false }),
      newApi: {
        getPublicModels: async () => {
          publicModelCalls += 1;
          return { total: 2, models: [{ id: 'gpt-5.6-sol', endpointTypes: ['openai'] }] };
        },
        getAvailableModels: async () => { throw new Error('Bridge model endpoint must not be called'); },
        getApiAccess: async () => { throw new Error('Bridge key endpoint must not be called'); },
        getTopUpOptions: async () => { throw new Error('Bridge payment endpoint must not be called'); },
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push({ text: String((payload as { text?: string }).text ?? ''), payload });
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(101, 'models-public', 'models') as never);
    await bot.handleUpdate(callbackUpdate(102, 'api-portal', 'api-access') as never);
    await bot.handleUpdate(callbackUpdate(103, 'topup-portal', 'topup') as never);

    expect(publicModelCalls).toBe(1);
    expect(sent.some((item) => item.text.includes('公开模型目录'))).toBe(true);
    expect(sent.some((item) => item.text.includes('原生 new-api'))).toBe(true);
    const apiAccess = sent.find((item) => item.text.startsWith('API 接入'));
    expect(apiAccess).toBeDefined();
    expect(JSON.stringify(apiAccess?.payload)).toContain('https://portal.example.test');
  });

  it('does not forward credentials or payment credentials through support', async () => {
    const repository = new MemoryRepository();
    const sent: Array<{ chatId: string; text: string }> = [];
    const bot = createBot({
      config: config({ SUPPORT_CHAT_ID: '-99' }), repository, logger: pino({ enabled: false }),
      newApi: {
        getStatus: async () => status,
        resolveAccountByTelegramId: async () => account,
        getAccountById: async () => account,
        getUsage: async () => ({ quota: 1000 }),
        getSubscriptions: async () => [],
        getNotice: async () => '',
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') {
        const input = payload as { chat_id?: string | number; text?: string };
        sent.push({ chatId: String(input.chat_id), text: String(input.text ?? '') });
      }
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(4, '/support api_key=sk-secret-value') as never);

    expect(sent.some((item) => item.chatId === '-99')).toBe(false);
    expect(sent.some((item) => item.text.includes('请勿通过机器人发送'))).toBe(true);
  });

  it('creates a Bridge topup only after confirmation, sends a QR checkout, and refreshes status', async () => {
    const repository = new MemoryRepository();
    const sent: Array<{ text: string; payload: unknown }> = [];
    const photos: unknown[] = [];
    const options: TopUpOptions = {
      enabled: true,
      displayType: 'USD',
      minTopup: 10,
      amountOptions: [10, 20],
      paymentMethods: [{ type: 'alipay', name: '支付宝' }, { type: 'wxpay', name: '微信支付', minTopup: 20 }],
    };
    let createCalls = 0;
    let receivedIdempotencyKey = '';
    let statusCalls = 0;
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }),
      newApi: {
        getStatus: async () => status,
        resolveAccountByTelegramId: async () => account,
        getAccountById: async () => account,
        getUsage: async () => ({ quota: 1000 }),
        getSubscriptions: async () => [],
        getNotice: async () => '',
        getTopUpOptions: async () => options,
        quoteTopUp: async () => ({ topupAmount: 10, paymentMethod: 'alipay', payableAmount: '73.00', expiresIn: 900 }),
        createTopUp: async (_telegramId: string, amount: number, method: string, idempotencyKey: string) => {
          createCalls += 1;
          receivedIdempotencyKey = idempotencyKey;
          expect(amount).toBe(10);
          expect(method).toBe('alipay');
          return {
            orderRef: 'TGUSR42NO1234567890', status: 'pending', topupAmount: 10, paymentMethod: 'alipay',
            payableAmount: '73.00', checkoutUrl: 'https://new-api.example.test/api/integrations/telegram/v1/checkout/signed-token',
            expiresAt: 1_800_000_000,
          };
        },
        getTopUpStatus: async () => {
          statusCalls += 1;
          return {
            orderRef: 'TGUSR42NO1234567890', status: 'success', paymentMethod: 'alipay', payableAmount: '73.00',
            createdAt: 1_700_000_000, completedAt: 1_700_000_100, expiresAt: 1_800_000_000,
          };
        },
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push({ text: String((payload as { text?: string }).text ?? ''), payload });
      if (method === 'sendPhoto') photos.push(payload);
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : method === 'sendPhoto'
          ? { message_id: 2, date: 1, chat: { id: 1001, type: 'private' }, photo: [] }
          : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(10, '/topup') as never);
    await bot.handleUpdate(callbackUpdate(11, 'callback-amount-1', 'topup:amount:10') as never);
    await bot.handleUpdate(callbackUpdate(12, 'callback-quote-1', 'topup:quote:10:alipay') as never);
    expect(createCalls).toBe(0);

    const createUpdate = callbackUpdate(13, 'callback-create-1', 'topup:create:10:alipay');
    await bot.handleUpdate(createUpdate as never);
    await bot.handleUpdate(createUpdate as never);

    expect(createCalls).toBe(1);
    expect(receivedIdempotencyKey).toBe('callback-create-1');
    expect(photos).toHaveLength(1);
    expect(sent.some((message) => message.text.includes('待支付订单已创建'))).toBe(true);
    expect(sent.some((message) => JSON.stringify(message.payload).includes('https://new-api.example.test/api/integrations/telegram/v1/checkout/signed-token'))).toBe(true);

    await bot.handleUpdate(callbackUpdate(14, 'callback-status-1', 'topup:status:TGUSR42NO1234567890') as never);
    expect(statusCalls).toBe(1);
    expect(sent.some((message) => message.text.includes('充值已到账'))).toBe(true);
  });

  it('shows official onboarding, persists language, and pages the account model directory', async () => {
    const repository = new MemoryRepository();
    const sent: string[] = [];
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }),
      newApi: {
        getAvailableModels: async () => ({
          total: 2,
          models: [{ id: 'gpt-5.6-terra', endpointTypes: ['openai'] }],
          nextCursor: '1',
        }),
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push(String((payload as { text?: string }).text ?? ''));
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(30, '/start') as never);
    await bot.handleUpdate(callbackUpdate(31, 'language-en', 'language:en') as never);
    await bot.handleUpdate(messageUpdate(32, '/start') as never);
    await bot.handleUpdate(callbackUpdate(33, 'models-1', 'models') as never);

    expect(sent.some((text) => text.includes('一个 Key，连接全球主流 AI 模型'))).toBe(true);
    expect(sent.some((text) => text.includes('Welcome, Alice to SuperToken'))).toBe(true);
    expect(sent.some((text) => text.includes('Available models (2)'))).toBe(true);
    expect(sent.some((text) => text.includes('gpt-5.6-terra'))).toBe(true);
  });

  it('returns to the primary menu instead of the help resources from a menu callback', async () => {
    const repository = new MemoryRepository();
    const sent: Array<{ text: string; payload: unknown }> = [];
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }), newApi: {} as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push({ text: String((payload as { text?: string }).text ?? ''), payload });
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(39, 'menu-primary', 'help') as never);

    const menuPayload = JSON.stringify(sent.at(-1)?.payload);
    expect(menuPayload).toContain('"callback_data":"bind"');
    expect(menuPayload).toContain('"callback_data":"account"');
    expect(menuPayload).not.toContain('"url"');
  });

  it('walks a crypto mock order through Base USDT without a QR code and confirmation status', async () => {
    const repository = new MemoryRepository();
    const sent: string[] = [];
    const photos: unknown[] = [];
    const options: TopUpOptions = {
      enabled: true,
      displayType: 'USD',
      minTopup: 50,
      amountOptions: [50, 100, 200, 500, 1000],
      paymentMethods: [{
        type: 'crypto', name: 'USDT / USDC', cryptoNetworks: [
          { network: 'bsc', name: 'BNB Smart Chain (BEP-20)', assets: ['USDT', 'USDC'], requiredConfirmations: 12 },
          { network: 'base', name: 'Base', assets: ['USDT', 'USDC'], requiredConfirmations: 12 },
          { network: 'solana', name: 'Solana', assets: ['USDT', 'USDC'], requiredConfirmations: 32 },
        ],
      }],
    };
    let createCalls = 0;
    let statusCalls = 0;
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }),
      newApi: {
        getTopUpOptions: async () => options,
        quoteTopUp: async (_telegramId: string, amount: number, method: string, crypto: { asset: string; network: string }) => {
          expect(amount).toBe(50);
          expect(method).toBe('crypto');
          expect(crypto).toEqual({ asset: 'USDT', network: 'base' });
          return { topupAmount: 50, paymentMethod: 'crypto', payableAmount: '50.010000', expiresIn: 900, cryptoAsset: 'USDT', cryptoNetwork: 'base' };
        },
        createTopUp: async (_telegramId: string, _amount: number, _method: string, _key: string, crypto: { asset: string; network: string }) => {
          createCalls += 1;
          expect(crypto).toEqual({ asset: 'USDT', network: 'base' });
          return {
            orderRef: 'MOCKTG1', status: 'pending', topupAmount: 50, paymentMethod: 'crypto', payableAmount: '50.010000',
            cryptoAsset: 'USDT', cryptoNetwork: 'base', depositAddress: '0x3333333333333333333333333333333333333333',
            requiredConfirmations: 12, expiresAt: 1_800_000_000,
          };
        },
        getTopUpStatus: async () => {
          statusCalls += 1;
          return {
            orderRef: 'MOCKTG1', status: statusCalls === 1 ? 'processing' : 'success', paymentMethod: 'crypto', payableAmount: '50.010000',
            cryptoAsset: 'USDT', cryptoNetwork: 'base', requiredConfirmations: 12,
            createdAt: 1_700_000_000, expiresAt: 1_800_000_000,
          };
        },
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push(String((payload as { text?: string }).text ?? ''));
      if (method === 'sendPhoto') photos.push(payload);
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : method === 'sendPhoto'
          ? { message_id: 2, date: 1, chat: { id: 1001, type: 'private' }, photo: [] }
          : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(40, '/topup') as never);
    await bot.handleUpdate(callbackUpdate(41, 'crypto-amount', 'topup:amount:50') as never);
    await bot.handleUpdate(callbackUpdate(42, 'crypto-method', 'topup:crypto:50') as never);
    await bot.handleUpdate(callbackUpdate(43, 'crypto-asset', 'topup:crypto:asset:50:USDT') as never);
    await bot.handleUpdate(callbackUpdate(44, 'crypto-network', 'topup:crypto:network:50:USDT:base') as never);
    await bot.handleUpdate(callbackUpdate(45, 'crypto-create', 'topup:crypto:create:50:USDT:base') as never);
    await bot.handleUpdate(callbackUpdate(45, 'crypto-create', 'topup:crypto:create:50:USDT:base') as never);
    await bot.handleUpdate(callbackUpdate(46, 'crypto-status-1', 'topup:status:MOCKTG1') as never);
    await bot.handleUpdate(callbackUpdate(47, 'crypto-status-2', 'topup:status:MOCKTG1') as never);

    expect(createCalls).toBe(1);
    expect(photos).toHaveLength(0);
    expect(sent.some((text) => text.includes('链上充值订单已创建'))).toBe(true);
    expect(sent.some((text) => text.includes('Mock 地址不会接收'))).toBe(true);
    expect(sent.some((text) => text.includes('网络：Base'))).toBe(true);
    expect(sent.some((text) => text.includes('转账金额：50.010000 USDT'))).toBe(true);
    expect(sent.some((text) => text.includes('0x3333333333333333333333333333333333333333'))).toBe(true);
    expect(sent.some((text) => text.includes('正在确认'))).toBe(true);
    expect(sent.some((text) => text.includes('充值已到账'))).toBe(true);
  });

  it('does not create orders for an unbound account or an invalid topup amount', async () => {
    const repository = new MemoryRepository();
    const sent: string[] = [];
    let createCalls = 0;
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }),
      newApi: {
        getStatus: async () => status,
        resolveAccountByTelegramId: async () => account,
        getAccountById: async () => account,
        getUsage: async () => ({ quota: 1000 }),
        getSubscriptions: async () => [],
        getNotice: async () => '',
        getTopUpOptions: async () => { throw new Error('telegram account is not bound'); },
        createTopUp: async () => { createCalls += 1; throw new Error('unexpected create'); },
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push(String((payload as { text?: string }).text ?? ''));
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(20, '/topup') as never);
    await bot.handleUpdate(messageUpdate(21, '/topup 0') as never);

    expect(createCalls).toBe(0);
    expect(sent.some((text) => text.includes('充值暂不可用'))).toBe(true);
    expect(sent.some((text) => text.includes('充值金额必须是正整数'))).toBe(true);
  });

  it('manages masked API-key metadata through the Bridge without sending a full key', async () => {
    const repository = new MemoryRepository();
    const sent: Array<{ text: string; payload: unknown }> = [];
    const access: ApiAccess = {
      baseUrl: 'https://supertoken.example.test/v1',
      keyManagementUrl: 'https://supertoken.example.test/keys',
      profiles: [{ id: 'auto', label: 'Automatic routing', autoGroups: ['default', 'pro'] }, { id: 'pro', label: 'Pro' }],
      keyLimit: 5,
    };
    const rawKey = 'sk-live-should-never-be-sent-to-telegram';
    let key: ApiKey | undefined;
    let createdRequestId = '';
    const bot = createBot({
      config: config(), repository, logger: pino({ enabled: false }),
      newApi: {
        getApiAccess: async () => access,
        listApiKeys: async () => key ? [key] : [],
        createApiKey: async (_telegramId: string, profileIndex: number, requestId: string) => {
          expect(profileIndex).toBe(1);
          createdRequestId = requestId;
          key = {
            id: 8, name: 'Telegram test request', maskedKey: 'sk-l**********gram', status: 'enabled', group: 'pro',
            createdAt: 1_700_000_000, expiresAt: 1_800_000_000,
          };
          return key;
        },
        setApiKeyStatus: async (_telegramId: string, tokenId: number, enabled: boolean) => {
          expect(tokenId).toBe(8);
          expect(enabled).toBe(false);
          key = { ...(key as ApiKey), status: 'disabled' };
          return key;
        },
        deleteApiKey: async (_telegramId: string, tokenId: number) => {
          expect(tokenId).toBe(8);
          key = undefined;
        },
      } as never,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } } as never;
      if (method === 'sendMessage') sent.push({ text: String((payload as { text?: string }).text ?? ''), payload });
      return { ok: true, result: method === 'sendMessage'
        ? { message_id: 1, date: 1, chat: { id: 1001, type: 'private' }, text: (payload as { text?: string }).text ?? '' }
        : true } as never;
    });
    await bot.init();

    await bot.handleUpdate(messageUpdate(50, '/keys') as never);
    await bot.handleUpdate(callbackUpdate(51, 'keys-create', 'keys:create') as never);
    await bot.handleUpdate(callbackUpdate(52, 'keys-profile', 'keys:create:1') as never);
    await bot.handleUpdate(callbackUpdate(53, 'keys-confirm', 'keys:confirm:1:0123456789abcdef0123456789abcdef') as never);
    await bot.handleUpdate(callbackUpdate(54, 'keys-disable', 'keys:status:8:0') as never);
    await bot.handleUpdate(callbackUpdate(55, 'keys-delete', 'keys:delete:8') as never);
    await bot.handleUpdate(callbackUpdate(56, 'keys-delete-confirm', 'keys:deleteconfirm:8') as never);

    expect(createdRequestId).toBe('0123456789abcdef0123456789abcdef');
    expect(sent.some((message) => message.text.includes('API Key 已创建'))).toBe(true);
    expect(sent.some((message) => message.text.includes('已停用'))).toBe(true);
    expect(sent.some((message) => message.text.includes('API Key #8 已删除'))).toBe(true);
    expect(sent.some((message) => JSON.stringify(message.payload).includes(access.keyManagementUrl))).toBe(true);
    expect(sent.map((message) => `${message.text}\n${JSON.stringify(message.payload)}`).join('\n')).not.toContain(rawKey);
  });
});
