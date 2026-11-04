import { backoffFor } from './outbox.dispatcher.js';
import { inquiryIntervalFor } from '../reconciler/reconciler.service.js';

describe('backoffFor (outbox retries)', () => {
  it('waits longer after each failure, then settles at 30 min', () => {
    expect([1, 2, 3, 4, 5, 50].map(backoffFor)).toEqual([
      5_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000,
    ]);
  });
});

describe('inquiryIntervalFor (reconciler)', () => {
  const MIN = 60_000;
  it('asks often about young payments and rarely about old ones', () => {
    expect(inquiryIntervalFor(3 * MIN)).toBe(MIN);
    expect(inquiryIntervalFor(30 * MIN)).toBe(5 * MIN);
    expect(inquiryIntervalFor(3 * 60 * MIN)).toBe(30 * MIN);
  });
});
