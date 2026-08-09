import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { formatQuota, formatTimestamp } from './format.js';
import type { Locale } from './i18n.js';
import { NewApiError, type NewApiClient } from './new-api.js';
import { sendMessageWithRetry } from './telegram.js';
import type { BotRepository, NewApiAccount, NewApiStatus, Subscription } from './types.js';

export type NotificationWorkerDependencies = {
  config: Config;
  repository: BotRepository;
  newApi: NewApiClient;
  bot: Bot;
  logger: Logger;
};

export async function runNotificationCycle(deps: NotificationWorkerDependencies): Promise<void> {
  const bindings = await deps.repository.listActiveBindings();
  if (bindings.length === 0) return;
  const status = await deps.newApi.getStatus();
  const now = Math.floor(Date.now() / 1000);

  for (const { user, binding } of bindings) {
    const preference = await deps.repository.getNotificationPreference(user.telegramUserId);
    if (preference.paused) continue;
    try {
      const account = await resolveAccount(deps, binding.newApiUserId, user.telegramUserId);
      await checkLowQuota(deps, user.chatId, user.telegramUserId, account, status, preference.lowQuotaThreshold, user.locale);
      const subscriptions = await deps.newApi.getSubscriptions(account);
      await checkSubscriptionExpiry(
        deps,
        user.chatId,
        user.telegramUserId,
        account,
        subscriptions,
        preference.subscriptionNoticeDays,
        now,
        user.locale,
      );
    } catch (error) {
      deps.logger.warn({ err: error, newApiUserId: binding.newApiUserId }, 'notification check failed');
    }
  }
}

export function startNotificationWorker(deps: NotificationWorkerDependencies): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runNotificationCycle(deps);
    } catch (error) {
      deps.logger.warn({ err: error }, 'notification cycle failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), deps.config.notificationIntervalMs);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}

async function resolveAccount(
  deps: NotificationWorkerDependencies,
  newApiUserId: number,
  telegramUserId: string,
): Promise<NewApiAccount> {
  if (deps.config.newApiIntegrationMode === 'bridge') {
    return deps.newApi.resolveAccountByTelegramId(telegramUserId);
  }
  return deps.newApi.getAccountById(newApiUserId);
}

async function checkLowQuota(
  deps: NotificationWorkerDependencies,
  chatId: string,
  telegramUserId: string,
  account: NewApiAccount,
  status: NewApiStatus,
  preferenceThreshold?: number,
  locale: Locale = 'zh',
): Promise<void> {
  const threshold = preferenceThreshold ?? deps.config.notificationDefaultLowQuotaThreshold;
  if (threshold === undefined) return;
  const eventKey = `low-quota:${account.id}:${threshold}`;
  const remaining = account.quota - account.usedQuota;
  if (remaining > threshold) {
    await deps.repository.clearNotificationEvent(eventKey);
    return;
  }
  const claimed = await deps.repository.claimNotificationEvent(eventKey, telegramUserId, 'low_quota');
  if (!claimed) return;
  try {
    await sendMessageWithRetry(
      deps.bot.api,
      chatId,
      locale === 'en'
        ? `Balance alert\nRemaining quota: ${formatQuota(remaining, status)}\nThreshold: ${formatQuota(threshold, status)}`
        : `余额提醒\n剩余额度：${formatQuota(remaining, status)}\n当前阈值：${formatQuota(threshold, status)}`,
    );
  } catch (error) {
    await deps.repository.clearNotificationEvent(eventKey);
    throw error;
  }
}

async function checkSubscriptionExpiry(
  deps: NotificationWorkerDependencies,
  chatId: string,
  telegramUserId: string,
  account: NewApiAccount,
  subscriptions: Subscription[],
  noticeDays: number,
  now: number,
  locale: Locale = 'zh',
): Promise<void> {
  if (noticeDays <= 0) return;
  const deadline = now + noticeDays * 24 * 60 * 60;
  for (const subscription of subscriptions) {
    if (!subscription.id || !subscription.endTime || subscription.endTime <= now || subscription.endTime > deadline) {
      continue;
    }
    const eventKey = `subscription-expiry:${account.id}:${subscription.id}:${subscription.endTime}`;
    const claimed = await deps.repository.claimNotificationEvent(eventKey, telegramUserId, 'subscription_expiry');
    if (!claimed) continue;
    try {
      await sendMessageWithRetry(
        deps.bot.api,
        chatId,
        locale === 'en'
          ? `Subscription alert\nSubscription #${subscription.id} ends on ${formatTimestamp(subscription.endTime, locale)}.`
          : `订阅提醒\n订阅 #${subscription.id} 将于 ${formatTimestamp(subscription.endTime, locale)} 到期。`,
      );
    } catch (error) {
      await deps.repository.clearNotificationEvent(eventKey);
      if (error instanceof NewApiError) throw error;
      throw error;
    }
  }
}
