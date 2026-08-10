import { createBot } from './bot.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createRepository } from './db.js';
import { NewApiClient } from './new-api.js';
import { createServer } from './server.js';
import { startBroadcastWorker } from './broadcast-worker.js';
import { startTelegramUpdateWorker } from './update-worker.js';
import { startNotificationWorker } from './worker.js';

const config = loadConfig();
const logger = createLogger(config);
const repository = await createRepository(config.databaseUrl, logger);
const newApi = new NewApiClient(config, logger);
let wakeBroadcastWorker = (): void => {};
const bot = createBot({
  config,
  repository,
  newApi,
  logger,
  onBroadcastQueued: () => wakeBroadcastWorker(),
});
const stopNotificationWorker = startNotificationWorker({ config, repository, newApi, bot, logger });
const broadcastWorker = startBroadcastWorker({ config, repository, bot, logger });
wakeBroadcastWorker = broadcastWorker.wake;
let stopTelegramUpdateWorker = (): void => {};

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  stopNotificationWorker();
  broadcastWorker.stop();
  stopTelegramUpdateWorker();
  await repository.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

if (config.botMode === 'webhook') {
  const updateWorker = startTelegramUpdateWorker({ repository, bot, logger });
  stopTelegramUpdateWorker = updateWorker.stop;
  const server = createServer({ config, repository, newApi, onTelegramUpdateQueued: updateWorker.wake });
  await server.listen({ host: '0.0.0.0', port: config.port });
  await bot.api.setWebhook(`${config.publicBaseUrl}/telegram/webhook`, {
    secret_token: config.telegramWebhookSecret,
    allowed_updates: ['message', 'callback_query'],
  });
  logger.info({ port: config.port }, 'telegram webhook server started');
} else {
  await newApi.getStatus();
  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (botInfo) => logger.info({ username: botInfo.username }, 'telegram polling started'),
  });
}
