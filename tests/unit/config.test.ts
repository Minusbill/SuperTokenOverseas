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
    expect([...config.botAdminTelegramIds]).toEqual(['123', '456']);
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
});
