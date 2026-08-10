import 'dotenv/config';
import { z } from 'zod';

const optionalEnvString = z.preprocess((value) => value === '' ? undefined : value, z.string().optional());
const optionalSecret = z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional());
const optionalNumber = z.preprocess((value) => value === '' ? undefined : value, z.coerce.number().int().nonnegative().optional());
const optionalUrl = z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional());
const optionalDatabaseUrl = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().url().refine(
    (value) => value.startsWith('sqlite:') || value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'DATABASE_URL must use sqlite:, postgres://, or postgresql://',
  ).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BOT_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
  PUBLIC_BASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).default('development-webhook-secret'),
  NEW_API_INTEGRATION_MODE: z.enum(['admin', 'bridge']).default('admin'),
  NEW_API_BASE_URL: z.string().url(),
  NEW_API_PORTAL_URL: optionalUrl,
  NEW_API_PRICING_URL: optionalUrl,
  NEW_API_DOCS_URL: optionalUrl,
  NEW_API_TOPUP_URL: optionalUrl,
  TELEGRAM_TOPUP_MODE: z.enum(['disabled', 'mock', 'live']).optional(),
  NEW_API_ADMIN_PAT: optionalEnvString.pipe(z.string().min(1).optional()),
  NEW_API_INTEGRATION_SECRET: optionalSecret,
  NEW_API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(4000),
  DATABASE_URL: optionalDatabaseUrl,
  BOT_ADMIN_TELEGRAM_IDS: z.string().default(''),
  SUPPORT_CHAT_ID: z.preprocess((value) => value === '' ? undefined : value, z.string().regex(/^-?\d+$/).optional()),
  NOTIFICATION_INTERVAL_MS: z.coerce.number().int().min(60000).max(86400000).default(900000),
  NOTIFICATION_DEFAULT_LOW_QUOTA_THRESHOLD: optionalNumber,
  BROADCAST_DELAY_MS: z.coerce.number().int().min(0).max(10000).default(100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  botMode: 'polling' | 'webhook';
  publicBaseUrl?: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  newApiIntegrationMode: 'admin' | 'bridge';
  newApiBaseUrl: string;
  newApiPortalUrl: string;
  newApiPricingUrl: string;
  newApiDocsUrl?: string;
  newApiTopupUrl: string;
  telegramTopUpMode: 'disabled' | 'mock' | 'live';
  newApiAdminPat?: string;
  newApiIntegrationSecret?: string;
  newApiRequestTimeoutMs: number;
  databaseUrl?: string;
  botAdminTelegramIds: Set<string>;
  supportChatId?: string;
  notificationIntervalMs: number;
  notificationDefaultLowQuotaThreshold?: number;
  broadcastDelayMs: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  if (parsed.BOT_MODE === 'webhook' && !parsed.PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is required when BOT_MODE=webhook');
  }
  if (parsed.NEW_API_INTEGRATION_MODE === 'admin' && !parsed.NEW_API_ADMIN_PAT) {
    throw new Error('NEW_API_ADMIN_PAT is required when NEW_API_INTEGRATION_MODE=admin');
  }
  if (parsed.NEW_API_INTEGRATION_MODE === 'bridge' && !parsed.NEW_API_INTEGRATION_SECRET) {
    throw new Error('NEW_API_INTEGRATION_SECRET is required when NEW_API_INTEGRATION_MODE=bridge');
  }
  if (parsed.NODE_ENV === 'production' && !parsed.DATABASE_URL) {
    throw new Error('DATABASE_URL is required in production');
  }
  if (parsed.NODE_ENV === 'production' && parsed.BOT_MODE === 'webhook'
    && parsed.TELEGRAM_WEBHOOK_SECRET === 'development-webhook-secret') {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be explicitly configured in production webhook mode');
  }

  const adminIds = new Set(
    parsed.BOT_ADMIN_TELEGRAM_IDS.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const newApiBaseUrl = parsed.NEW_API_BASE_URL.replace(/\/$/, '');
  const newApiPortalUrl = (parsed.NEW_API_PORTAL_URL ?? newApiBaseUrl).replace(/\/$/, '');

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.BOT_PORT,
    botMode: parsed.BOT_MODE,
    ...(parsed.PUBLIC_BASE_URL ? { publicBaseUrl: parsed.PUBLIC_BASE_URL.replace(/\/$/, '') } : {}),
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: parsed.TELEGRAM_WEBHOOK_SECRET,
    newApiIntegrationMode: parsed.NEW_API_INTEGRATION_MODE,
    newApiBaseUrl,
    newApiPortalUrl,
    newApiPricingUrl: (parsed.NEW_API_PRICING_URL ?? `${newApiPortalUrl}/pricing`).replace(/\/$/, ''),
    ...(parsed.NEW_API_DOCS_URL ? { newApiDocsUrl: parsed.NEW_API_DOCS_URL.replace(/\/$/, '') } : {}),
    newApiTopupUrl: (parsed.NEW_API_TOPUP_URL ?? newApiPortalUrl).replace(/\/$/, ''),
    telegramTopUpMode: parsed.TELEGRAM_TOPUP_MODE ?? (parsed.NODE_ENV === 'production' ? 'disabled' : 'mock'),
    ...(parsed.NEW_API_ADMIN_PAT ? { newApiAdminPat: parsed.NEW_API_ADMIN_PAT } : {}),
    ...(parsed.NEW_API_INTEGRATION_SECRET
      ? { newApiIntegrationSecret: parsed.NEW_API_INTEGRATION_SECRET }
      : {}),
    newApiRequestTimeoutMs: parsed.NEW_API_REQUEST_TIMEOUT_MS,
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
    botAdminTelegramIds: adminIds,
    ...(parsed.SUPPORT_CHAT_ID ? { supportChatId: parsed.SUPPORT_CHAT_ID } : {}),
    notificationIntervalMs: parsed.NOTIFICATION_INTERVAL_MS,
    ...(parsed.NOTIFICATION_DEFAULT_LOW_QUOTA_THRESHOLD !== undefined
      ? { notificationDefaultLowQuotaThreshold: parsed.NOTIFICATION_DEFAULT_LOW_QUOTA_THRESHOLD }
      : {}),
    broadcastDelayMs: parsed.BROADCAST_DELAY_MS,
    logLevel: parsed.LOG_LEVEL,
  };
}
