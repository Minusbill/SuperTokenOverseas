import { describe, expect, it } from 'vitest';
import { formatQuota, formatSubscriptions } from '../../src/format.js';
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
