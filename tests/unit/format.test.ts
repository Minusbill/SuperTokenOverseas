import { describe, expect, it } from 'vitest';
import { formatBillingPrice, formatNotificationPreference, formatQuota, formatSubscriptions, quotaFromDisplayAmount } from '../../src/format.js';
import type { NewApiStatus } from '../../src/types.js';

const status: NewApiStatus = { quotaPerUnit: 500_000, quotaDisplayType: 'USD', usdExchangeRate: 7.2 };

describe('quota formatting', () => {
  it('converts internal quota units to USD', () => {
    expect(formatQuota(500_000, status)).toBe('$1.00');
  });

  it('supports token display without a floating point conversion', () => {
    expect(formatQuota(1234.8, { quotaPerUnit: 500_000, quotaDisplayType: 'TOKENS' })).toBe('1,235 tokens');
  });

  it('shows a zero currency balance with the standard two decimal places', () => {
    expect(formatQuota(0, status)).toBe('$0.00');
  });

  it('converts a displayed threshold back to internal quota units', () => {
    expect(quotaFromDisplayAmount(50, status)).toBe(25_000_000);
    expect(quotaFromDisplayAmount(72, { ...status, quotaDisplayType: 'CNY' })).toBe(5_000_000);
    expect(quotaFromDisplayAmount(1.5, { ...status, quotaDisplayType: 'TOKENS' })).toBeUndefined();
  });

  it('formats a stored notification threshold in the account display unit', () => {
    expect(formatNotificationPreference({
      telegramUserId: '1001', lowQuotaThreshold: 25_000_000, subscriptionNoticeDays: 3,
      paused: false, updatedAt: new Date(),
    }, 'en', status)).toContain('Low balance threshold: $50.00');
  });

  it('uses a currency, rather than tokens, for model billing prices', () => {
    expect(formatBillingPrice(1, { ...status, quotaDisplayType: 'TOKENS' })).toBe('$1');
    expect(formatBillingPrice(0.5, { ...status, quotaDisplayType: 'CNY' })).toBe('¥3.6');
    expect(formatBillingPrice(0.5, {
      ...status, quotaDisplayType: 'CUSTOM', customCurrencySymbol: 'S$', customCurrencyExchangeRate: 2,
    })).toBe('S$1');
  });
});

describe('subscription formatting', () => {
  it('returns a stable empty state', () => {
    expect(formatSubscriptions([])).toBe('当前没有订阅记录。');
  });

  it('uses the same quota display as the account summary when a status is available', () => {
    expect(formatSubscriptions([{
      planName: 'Pro', status: 'active', endTime: 1_800_000_000, remainingAmount: 320_000,
    }], status)).toContain('剩余额度：$0.64');
  });

  it('renders subscription labels in English when requested', () => {
    expect(formatSubscriptions([{
      planName: 'Pro', status: 'active', endTime: 1_800_000_000, remainingAmount: 320_000,
    }], status, 'en')).toContain('Remaining: $0.64');
  });
});
