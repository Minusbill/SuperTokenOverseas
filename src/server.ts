import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { BotRepository } from './types.js';
import type { NewApiClient } from './new-api.js';

const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
}).passthrough();

export type ServerDependencies = {
  config: Config;
  repository: BotRepository;
  newApi: NewApiClient;
  onTelegramUpdateQueued?: () => void;
};

export function createServer(deps: ServerDependencies): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: 1_000_000 });

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
    const update = telegramUpdateSchema.safeParse(request.body);
    if (!update.success) return reply.code(400).send({ ok: false });
    const enqueued = await deps.repository.enqueueTelegramUpdate(
      update.data.update_id,
      JSON.stringify(update.data),
    );
    if (enqueued) deps.onTelegramUpdateQueued?.();
    return { ok: true };
  });

  return server as FastifyInstance;
}
