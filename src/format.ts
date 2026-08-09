import type { NewApiStatus, NotificationPreference, RepositoryStats, Subscription, UsageStat } from './types.js';

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
  return `${symbol}${amount.toFixed(Math.abs(amount) < 1 ? 4 : 2)}`;
}

export function formatTimestamp(timestamp?: number): string {
  if (!timestamp || timestamp <= 0) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(timestamp * 1000));
}

export function formatUsage(usage: UsageStat, status: NewApiStatus): string {
  const lines = [`消耗：${formatQuota(usage.quota, status)}`];
  if (usage.rpm !== undefined) lines.push(`请求速率：${usage.rpm}`);
  if (usage.tpm !== undefined) lines.push(`Token 速率：${usage.tpm}`);
  return lines.join('\n');
}

export function formatSubscriptions(subscriptions: Subscription[]): string {
  if (subscriptions.length === 0) return '当前没有订阅记录。';
  return subscriptions
    .slice(0, 5)
    .map((subscription, index) => {
      const name = subscription.planName ?? `订阅 ${index + 1}`;
      const status = subscription.status ?? 'unknown';
      const end = formatTimestamp(subscription.endTime);
      const remaining = subscription.remainingAmount !== undefined
        ? `\n剩余额度：${subscription.remainingAmount.toLocaleString()}`
        : '';
      return `${name}\n状态：${status}\n到期：${end}${remaining}`;
    })
    .join('\n\n');
}

export function formatNotice(notice: string): string {
  const normalized = notice.trim();
  if (!normalized) return '当前没有公告。';
  return normalized.length > 3800 ? `${normalized.slice(0, 3797)}...` : normalized;
}

export function formatNotificationPreference(preference: NotificationPreference): string {
  const threshold = preference.lowQuotaThreshold === undefined
    ? '未设置'
    : preference.lowQuotaThreshold.toLocaleString();
  return [
    `低余额阈值：${threshold}`,
    `订阅到期提醒：提前 ${preference.subscriptionNoticeDays} 天`,
    `通知状态：${preference.paused ? '已暂停' : '已开启'}`,
  ].join('\n');
}

export function formatRepositoryStats(stats: RepositoryStats): string {
  return [
    '机器人运行摘要',
    `活跃 Telegram 用户：${stats.telegramUsers}`,
    `活跃绑定：${stats.activeBindings}`,
    `未关闭工单：${stats.openTickets}`,
  ].join('\n');
}
