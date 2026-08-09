import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { BotRepository } from './types.js';
import type { NewApiClient } from './new-api.js';

export type ServerDependencies = {
  config: Config;
  bot: Bot;
  repository: BotRepository;
  newApi: NewApiClient;
  logger: Logger;
};

export function createServer(deps: ServerDependencies): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get('/healthz', async () => ({ ok: true }));
  server.get('/readyz', async (_request, reply) => {
    try {
      await deps.repository.getStats();
      await deps.newApi.getStatus();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, reason: 'new-api-unavailable' });
    }
  });

  server.post<{ Body: unknown }>('/telegram/webhook', async (request, reply) => {
    const header = request.headers['x-telegram-bot-api-secret-token'];
    if (header !== deps.config.telegramWebhookSecret) {
      return reply.code(401).send({ ok: false });
    }
    await deps.bot.handleUpdate(request.body as Parameters<Bot['handleUpdate']>[0]);
    return { ok: true };
  });

  return server as FastifyInstance;
}
