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
});

describe('subscription formatting', () => {
  it('returns a stable empty state', () => {
    expect(formatSubscriptions([])).toBe('当前没有订阅记录。');
  });
});
