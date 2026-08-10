import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    BOT_MODE: 'polling',
    TELEGRAM_BOT_TOKEN: 'test-token',
    NEW_API_BASE_URL: 'https://new-api.example.test',
    NEW_API_INTEGRATION_MODE: 'bridge',
    NEW_API_INTEGRATION_SECRET: 'integration-secret-123456',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('normalizes the base URL and parses administrator IDs', () => {
    const config = loadConfig(baseEnv({
      NEW_API_BASE_URL: 'https://new-api.example.test/',
      BOT_ADMIN_TELEGRAM_IDS: '123, 456,123',
    }));

    expect(config.newApiBaseUrl).toBe('https://new-api.example.test');
    expect(config.newApiPortalUrl).toBe('https://new-api.example.test');
    expect(config.newApiPricingUrl).toBe('https://new-api.example.test/pricing');
    expect([...config.botAdminTelegramIds]).toEqual(['123', '456']);
  });

  it('uses explicitly configured user-facing portal URLs', () => {
    const config = loadConfig(baseEnv({
      NEW_API_PORTAL_URL: 'https://portal.example.test/',
      NEW_API_PRICING_URL: 'https://portal.example.test/pricing/',
      NEW_API_DOCS_URL: 'https://docs.example.test/',
      NEW_API_TOPUP_URL: 'https://portal.example.test/billing/',
    }));

    expect(config.newApiPortalUrl).toBe('https://portal.example.test');
    expect(config.newApiPricingUrl).toBe('https://portal.example.test/pricing');
    expect(config.newApiDocsUrl).toBe('https://docs.example.test');
    expect(config.newApiTopupUrl).toBe('https://portal.example.test/billing');
  });

  it('requires the bridge secret when bridge mode is enabled', () => {
    expect(() => loadConfig(baseEnv({ NEW_API_INTEGRATION_SECRET: undefined }))).toThrow(
      'NEW_API_INTEGRATION_SECRET is required when NEW_API_INTEGRATION_MODE=bridge',
    );
  });

  it('treats blank optional environment values as unset', () => {
    const config = loadConfig(baseEnv({
      NEW_API_INTEGRATION_MODE: 'admin',
      NEW_API_ADMIN_PAT: 'admin-pat',
      NEW_API_INTEGRATION_SECRET: '',
      SUPPORT_CHAT_ID: '',
      NOTIFICATION_DEFAULT_LOW_QUOTA_THRESHOLD: '',
    }));
    expect(config.newApiIntegrationSecret).toBeUndefined();
    expect(config.supportChatId).toBeUndefined();
    expect(config.notificationDefaultLowQuotaThreshold).toBeUndefined();
  });

  it('requires a database in production', () => {
    expect(() => loadConfig(baseEnv({ NODE_ENV: 'production' }))).toThrow(
      'DATABASE_URL is required in production',
    );
  });

  it('keeps Telegram checkout in mock mode for tests and disabled by default in production', () => {
    expect(loadConfig(baseEnv()).telegramTopUpMode).toBe('mock');
    expect(loadConfig(baseEnv({ NODE_ENV: 'production', DATABASE_URL: 'sqlite:./data/bot.sqlite' })).telegramTopUpMode).toBe('disabled');
    expect(loadConfig(baseEnv({ TELEGRAM_TOPUP_MODE: 'live' })).telegramTopUpMode).toBe('live');
  });

  it('accepts SQLite as the initial persistent store', () => {
    const config = loadConfig(baseEnv({ DATABASE_URL: 'sqlite:./data/supertoken_bot.sqlite' }));
    expect(config.databaseUrl).toBe('sqlite:./data/supertoken_bot.sqlite');
  });

  it('rejects unsupported database schemes', () => {
    expect(() => loadConfig(baseEnv({ DATABASE_URL: 'mysql://localhost/supertoken_bot' }))).toThrow(
      'DATABASE_URL must use sqlite:, postgres://, or postgresql://',
    );
  });

  it('requires a public URL for webhook mode', () => {
    expect(() => loadConfig(baseEnv({ BOT_MODE: 'webhook' }))).toThrow(
      'PUBLIC_BASE_URL is required when BOT_MODE=webhook',
    );
  });

  it('rejects the development webhook secret in production', () => {
    expect(() => loadConfig(baseEnv({
      NODE_ENV: 'production', BOT_MODE: 'webhook', PUBLIC_BASE_URL: 'https://bot.example.test',
      DATABASE_URL: 'sqlite:./data/bot.sqlite',
    }))).toThrow('TELEGRAM_WEBHOOK_SECRET must be explicitly configured');
  });
});
