import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { BotRepository } from './types.js';

const retryDelayMs = 5_000;

export type TelegramUpdateWorkerDependencies = {
  repository: BotRepository;
  bot: Bot;
  logger: Logger;
};

export type TelegramUpdateWorker = {
  wake(): void;
  stop(): void;
};

export async function processQueuedTelegramUpdates(
  deps: TelegramUpdateWorkerDependencies,
  options: { maxJobs?: number; retryDelayMs?: number } = {},
): Promise<{ completed: number; retried: number; failed: number }> {
  const maxJobs = options.maxJobs ?? 50;
  const retryAfterMs = options.retryDelayMs ?? retryDelayMs;
  let completed = 0;
  let retried = 0;
  let failed = 0;

  for (let index = 0; index < maxJobs; index += 1) {
    const job = await deps.repository.claimQueuedTelegramUpdate();
    if (!job) break;
    try {
      const update = JSON.parse(job.payload) as Parameters<Bot['handleUpdate']>[0];
      await deps.bot.handleUpdate(update);
      await deps.repository.completeQueuedTelegramUpdate(job.updateId);
      completed += 1;
    } catch (error) {
      const outcome = await deps.repository.retryQueuedTelegramUpdate(
        job.updateId,
        new Date(Date.now() + retryAfterMs),
      );
      deps.logger.error({ errorType: errorType(error), updateId: job.updateId, attempts: job.attempts }, 'queued telegram update failed');
      if (outcome === 'failed') {
        await deps.repository.writeAudit({
          action: 'telegram_update.failed', targetType: 'telegram_update', targetId: String(job.updateId),
        });
        failed += 1;
      }
      else retried += 1;
      break;
    }
  }
  return { completed, retried, failed };
}

export function startTelegramUpdateWorker(deps: TelegramUpdateWorkerDependencies): TelegramUpdateWorker {
  let running = false;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await processQueuedTelegramUpdates(deps);
    } catch (error) {
      deps.logger.error({ errorType: errorType(error) }, 'telegram update queue worker failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), 1_000);
  timer.unref();
  void run();
  return {
    wake: () => void run(),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
