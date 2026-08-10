import type { NewApiStatus, NotificationPreference, RepositoryStats, Subscription, UsageStat } from './types.js';
import type { Locale } from './i18n.js';

export function formatQuota(quota: number, status: NewApiStatus): string {
  if (!Number.isFinite(quota)) return '-';
  if (status.quotaDisplayType === 'TOKENS') return `${Math.round(quota).toLocaleString()} tokens`;

  const usd = quota / status.quotaPerUnit;
  let amount = usd;
  let symbol = '$';
  if (status.quotaDisplayType === 'CNY') {
    amount = usd * (status.usdExchangeRate ?? 1);
    symbol = '¥';
  } else if (status.quotaDisplayType === 'CUSTOM') {
    amount = usd * (status.customCurrencyExchangeRate ?? 1);
    symbol = status.customCurrencySymbol ?? '';
  }
  const fractionDigits = amount !== 0 && Math.abs(amount) < 1 ? 4 : 2;
  return `${symbol}${amount.toFixed(fractionDigits)}`;
}

export function quotaFromDisplayAmount(amount: number, status: NewApiStatus): number | undefined {
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  if (status.quotaDisplayType === 'TOKENS') {
    return Number.isSafeInteger(amount) ? amount : undefined;
  }

  const exchangeRate = status.quotaDisplayType === 'CNY'
    ? status.usdExchangeRate ?? 1
    : status.quotaDisplayType === 'CUSTOM'
      ? status.customCurrencyExchangeRate ?? 1
      : 1;
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) return undefined;
  const quota = Math.round((amount / exchangeRate) * status.quotaPerUnit);
  return Number.isSafeInteger(quota) && quota >= 0 ? quota : undefined;
}

/**
 * Formats a USD billing value using the public model-pricing display currency.
 * Unlike quota formatting, a token display configuration still uses USD here.
 */
export function formatBillingPrice(usd: number, status?: NewApiStatus): string {
  if (!Number.isFinite(usd) || usd < 0) return '-';
  if (usd === 0) return '$0';
  if (usd < 0.00000001) return '<$0.00000001';

  let amount = usd;
  let symbol = '$';
  if (status?.quotaDisplayType === 'CNY') {
    const exchangeRate = status.usdExchangeRate ?? 1;
    if (Number.isFinite(exchangeRate) && exchangeRate > 0) amount *= exchangeRate;
    symbol = '¥';
  } else if (status?.quotaDisplayType === 'CUSTOM') {
    const exchangeRate = status.customCurrencyExchangeRate ?? 1;
    if (Number.isFinite(exchangeRate) && exchangeRate > 0) amount *= exchangeRate;
    symbol = status.customCurrencySymbol ?? '';
  }

  return `${symbol}${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: amount < 1 ? 8 : 4,
  }).format(amount)}`;
}

export function formatTimestamp(timestamp?: number, locale: Locale = 'zh'): string {
  if (!timestamp || timestamp <= 0) return '-';
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(timestamp * 1000));
}

export function formatUsage(usage: UsageStat, status: NewApiStatus, locale: Locale = 'zh'): string {
  const lines = [locale === 'en' ? `Used: ${formatQuota(usage.quota, status)}` : `消耗：${formatQuota(usage.quota, status)}`];
  if (usage.rpm !== undefined) lines.push(locale === 'en' ? `Requests/min: ${usage.rpm}` : `请求速率：${usage.rpm}`);
  if (usage.tpm !== undefined) lines.push(locale === 'en' ? `Tokens/min: ${usage.tpm}` : `Token 速率：${usage.tpm}`);
  return lines.join('\n');
}

export function formatSubscriptions(subscriptions: Subscription[], status?: NewApiStatus, locale: Locale = 'zh'): string {
  if (subscriptions.length === 0) return locale === 'en' ? 'No subscription records.' : '当前没有订阅记录。';
  return subscriptions
    .slice(0, 5)
    .map((subscription, index) => {
      const name = subscription.planName ?? (locale === 'en' ? `Subscription ${index + 1}` : `订阅 ${index + 1}`);
      const subscriptionStatus = subscription.status ?? 'unknown';
      const end = formatTimestamp(subscription.endTime, locale);
      const remaining = subscription.remainingAmount !== undefined
        ? locale === 'en'
          ? `\nRemaining: ${status ? formatQuota(subscription.remainingAmount, status) : subscription.remainingAmount.toLocaleString()}`
          : `\n剩余额度：${status ? formatQuota(subscription.remainingAmount, status) : subscription.remainingAmount.toLocaleString()}`
        : '';
      return locale === 'en'
        ? `${name}\nStatus: ${subscriptionStatus}\nEnds: ${end}${remaining}`
        : `${name}\n状态：${subscriptionStatus}\n到期：${end}${remaining}`;
    })
    .join('\n\n');
}

export function formatNotice(notice: string, locale: Locale = 'zh'): string {
  const normalized = notice.trim();
  if (!normalized) return locale === 'en' ? 'No announcements at the moment.' : '当前没有公告。';
  return normalized.length > 3800 ? `${normalized.slice(0, 3797)}...` : normalized;
}

export function formatNotificationPreference(
  preference: NotificationPreference,
  locale: Locale = 'zh',
  status?: NewApiStatus,
): string {
  const threshold = preference.lowQuotaThreshold === undefined
    ? locale === 'en' ? 'Not set' : '未设置'
    : status
      ? formatQuota(preference.lowQuotaThreshold, status)
      : preference.lowQuotaThreshold.toLocaleString();
  if (locale === 'en') {
    return [
      `Low balance threshold: ${threshold}`,
      `Subscription reminder: ${preference.subscriptionNoticeDays} day(s) before expiry`,
      `Notifications: ${preference.paused ? 'Paused' : 'Enabled'}`,
    ].join('\n');
  }
  return [
    `低余额阈值：${threshold}`,
    `订阅到期提醒：提前 ${preference.subscriptionNoticeDays} 天`,
    `通知状态：${preference.paused ? '已暂停' : '已开启'}`,
  ].join('\n');
}

export function formatRepositoryStats(stats: RepositoryStats, locale: Locale = 'zh'): string {
  if (locale === 'en') {
    return [
      'Bot status',
      `Active Telegram users: ${stats.telegramUsers}`,
      `Active account links: ${stats.activeBindings}`,
      `Open support tickets: ${stats.openTickets}`,
    ].join('\n');
  }
  return [
    '机器人运行摘要',
    `活跃 Telegram 用户：${stats.telegramUsers}`,
    `活跃绑定：${stats.activeBindings}`,
    `未关闭工单：${stats.openTickets}`,
  ].join('\n');
}
