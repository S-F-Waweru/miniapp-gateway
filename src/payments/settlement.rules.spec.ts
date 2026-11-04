import type { Payment, PaymentStatus } from '../generated/prisma/client.js';
import type { ProviderOutcome } from '../providers/payment.provider.interface.js';
import { ALLOWED, decideExpiry, decideOutcome } from './settlement.rules.js';

const EXPIRES = new Date('2026-11-04T10:15:00Z');
const BEFORE = new Date('2026-11-04T10:05:00Z');
const AFTER = new Date('2026-11-04T10:20:00Z');

const payment = (over: Partial<Payment> = {}): Payment => ({
  id: 'pay_1',
  bookingRef: 'B1',
  attempt: 1,
  idempotencyKey: 'k1',
  requestHash: 'h',
  amount: 1500n,
  currency: 'KES',
  title: 't',
  customerRef: null,
  status: 'PENDING',
  providerRef: 'P1',
  tradeNO: 'P1',
  paymentUrl: null,
  paidAmount: null,
  paidCurrency: null,
  late: false,
  duplicate: false,
  expiresAt: EXPIRES,
  paidAt: null,
  lastInquiryAt: null,
  createdAt: BEFORE,
  updatedAt: BEFORE,
  ...over,
});

const paid = (over: Partial<ProviderOutcome> = {}): ProviderOutcome => ({
  status: 'PAID',
  providerRef: 'P1',
  amount: 1500n,
  currency: 'KES',
  ...over,
});

describe('decideOutcome', () => {
  it('PENDING + matching PAID before expiry → succeeded', () => {
    const d = decideOutcome(payment(), [], paid(), BEFORE);
    expect(d?.to).toBe('PAID');
    expect(d?.event).toBe('payment.succeeded');
    expect(d?.set).toMatchObject({
      late: false,
      duplicate: false,
      paidAmount: 1500n,
      paidAt: BEFORE,
    });
  });

  it('PENDING + PAID after expiresAt → late (the seat hold may be gone)', () => {
    const d = decideOutcome(payment(), [], paid(), AFTER);
    expect(d?.event).toBe('payment.late_succeeded');
    expect(d?.set?.late).toBe(true);
  });

  it.each(['FAILED', 'EXPIRED'] as const)(
    '%s + PAID → PAID late (money is never dropped)',
    (status) => {
      const d = decideOutcome(payment({ status }), [], paid(), BEFORE);
      expect(d?.to).toBe('PAID');
      expect(d?.event).toBe('payment.late_succeeded');
    },
  );

  it('PAID while another attempt is already PAID → duplicate', () => {
    const other = payment({ id: 'pay_2', attempt: 2, status: 'PAID' });
    const d = decideOutcome(
      payment({ status: 'FAILED' }),
      [other],
      paid(),
      BEFORE,
    );
    expect(d?.event).toBe('payment.duplicate');
    expect(d?.set?.duplicate).toBe(true);
  });

  it.each([
    ['wrong amount', { amount: 15n }],
    ['wrong currency', { currency: 'USD' }],
    ['missing amount', { amount: undefined }],
  ])('%s → AMOUNT_MISMATCH', (_name, over) => {
    const d = decideOutcome(payment(), [], paid(over), BEFORE);
    expect(d?.to).toBe('AMOUNT_MISMATCH');
    expect(d?.event).toBe('payment.amount_mismatch');
  });

  it('records the providerRef if we never got one (pay call timed out)', () => {
    const d = decideOutcome(payment({ providerRef: null }), [], paid(), BEFORE);
    expect(d?.set?.providerRef).toBe('P1');
  });

  it('PENDING + FAILED → failed', () => {
    const d = decideOutcome(payment(), [], { status: 'FAILED' }, BEFORE);
    expect(d?.to).toBe('FAILED');
  });

  it.each([
    ['still processing', payment(), { status: 'PENDING' as const }],
    ['PAID again', payment({ status: 'PAID' }), paid()],
    [
      'FAILED after PAID',
      payment({ status: 'PAID' }),
      { status: 'FAILED' as const },
    ],
    [
      'FAILED after EXPIRED',
      payment({ status: 'EXPIRED' }),
      { status: 'FAILED' as const },
    ],
    [
      'anything after AMOUNT_MISMATCH',
      payment({ status: 'AMOUNT_MISMATCH' }),
      paid(),
    ],
  ])('%s → no change', (_name, p, o) => {
    expect(decideOutcome(p, [], o, BEFORE)).toBeNull();
  });

  it('never proposes a transition outside ALLOWED (all combinations)', () => {
    const statuses: PaymentStatus[] = [
      'PENDING',
      'PAID',
      'FAILED',
      'EXPIRED',
      'AMOUNT_MISMATCH',
    ];
    const outcomes: ProviderOutcome[] = [
      paid(),
      paid({ amount: 1n }),
      { status: 'FAILED' },
      { status: 'PENDING' },
    ];
    for (const status of statuses) {
      for (const o of outcomes) {
        for (const now of [BEFORE, AFTER]) {
          const d = decideOutcome(payment({ status }), [], o, now);
          if (d) expect(ALLOWED[status]).toContain(d.to);
        }
      }
      const e = decideExpiry(payment({ status }));
      if (e) expect(ALLOWED[status]).toContain(e.to);
    }
  });
});

describe('decideExpiry', () => {
  it('only a PENDING payment can expire', () => {
    expect(decideExpiry(payment())?.to).toBe('EXPIRED');
    expect(decideExpiry(payment({ status: 'PAID' }))).toBeNull();
    expect(decideExpiry(payment({ status: 'FAILED' }))).toBeNull();
  });
});
