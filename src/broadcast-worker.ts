import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { sendMessageWithRetry } from './telegram.js';
import type { BotRepository } from './types.js';

const defaultRetryDelayMs = 5_000;

export type BroadcastWorkerDependencies = {
  config: Config;
  repository: BotRepository;
  bot: Bot;
  logger: Logger;
};

export type BroadcastWorker = {
  wake(): void;
  stop(): void;
};

export async function processBroadcastDeliveries(
  deps: BroadcastWorkerDependencies,
  options: { maxJobs?: number; retryDelayMs?: number; delayMs?: number } = {},
): Promise<{ completed: number; retried: number; failed: number; cancelled: number }> {
  const maxJobs = options.maxJobs ?? 50;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const delayMs = options.delayMs ?? deps.config.broadcastDelayMs;
  let completed = 0;
  let retried = 0;
  let failed = 0;
  let cancelled = 0;

  for (let index = 0; index < maxJobs; index += 1) {
    const job = await deps.repository.claimBroadcastDelivery();
    if (!job) break;
    try {
      await sendMessageWithRetry(deps.bot.api, job.chatId, job.message);
      await deps.repository.completeBroadcastDelivery(job.broadcastId, job.telegramUserId);
      completed += 1;
    } catch (error) {
      const outcome = await deps.repository.retryBroadcastDelivery(
        job.broadcastId,
        job.telegramUserId,
        new Date(Date.now() + retryDelayMs),
      );
      deps.logger.warn({
        errorType: errorType(error), broadcastId: job.broadcastId, telegramUserId: job.telegramUserId, attempts: job.attempts,
      }, 'broadcast delivery failed');
      if (outcome === 'failed') {
        await deps.repository.writeAudit({
          action: 'broadcast.delivery_failed', targetType: 'broadcast', targetId: job.broadcastId,
        });
        failed += 1;
      } else if (outcome === 'cancelled') {
        cancelled += 1;
      } else {
        retried += 1;
      }
      // Do not burn all retry attempts in one worker run when a test or
      // deployment intentionally uses a zero retry delay.
      break;
    }
    if (delayMs > 0 && index + 1 < maxJobs) await wait(delayMs);
  }
  return { completed, retried, failed, cancelled };
}

export function startBroadcastWorker(deps: BroadcastWorkerDependencies): BroadcastWorker {
  let running = false;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await processBroadcastDeliveries(deps);
    } catch (error) {
      deps.logger.error({ errorType: errorType(error) }, 'broadcast worker failed');
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
