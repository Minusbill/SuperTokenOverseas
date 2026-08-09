import pino, { type Logger } from 'pino';
import type { Config } from './config.js';

const secretKeys = new Set([
  'authorization',
  'access_token',
  'api_key',
  'bot_token',
  'telegram_bot_token',
  'new_api_admin_pat',
  'new_api_integration_secret',
]);

function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      secretKeys.has(key.toLowerCase()) ? '[REDACTED]' : redactObject(entry),
    ]),
  );
}

export function createLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    base: null,
    serializers: {
      err: pino.stdSerializers.err,
    },
    hooks: {
      logMethod(inputArgs, method) {
        if (inputArgs.length === 1 && inputArgs[0] && typeof inputArgs[0] === 'object') {
          method.apply(this, [redactObject(inputArgs[0])]);
          return;
        }
        method.apply(this, inputArgs);
      },
    },
  });
}
