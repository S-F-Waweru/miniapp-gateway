import type { Payment, PaymentStatus } from '../generated/prisma/client.js';
import type { ProviderOutcome } from '../providers/payment.provider.interface.js';
import { PaymentEvent, type PaymentEventType } from './events.js';

/** Every legal status change. Anything else is a bug and is refused. */
export const ALLOWED: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ['PAID', 'FAILED', 'EXPIRED', 'AMOUNT_MISMATCH'],
  FAILED: ['PAID', 'AMOUNT_MISMATCH'], // late money
  EXPIRED: ['PAID', 'AMOUNT_MISMATCH'], // late money
  PAID: [], // final
  AMOUNT_MISMATCH: [], // final
};

export type Decision = {
  to: PaymentStatus;
  event: PaymentEventType;
  set?: {
    paidAt?: Date;
    paidAmount?: bigint | null;
    paidCurrency?: string | null;
    providerRef?: string;
    late?: boolean;
    duplicate?: boolean;
  };
  detail?: Record<string, string | number | boolean | null>;
};

/**
 * What a provider outcome means for this payment.
 * Pure: no database, no network, no clock (now is passed in). null = no change.
 */
export function decideOutcome(
  p: Payment,
  siblings: Payment[], // the other attempts of the same booking
  o: ProviderOutcome,
  now: Date,
): Decision | null {
  // Processing / unknown: never guess.
  if (o.status === 'PENDING') return null;

  // A failure only matters for an open payment. FAILED after PAID is noise.
  if (o.status === 'FAILED') {
    return p.status === 'PENDING'
      ? { to: 'FAILED', event: PaymentEvent.FAILED }
      : null;
  }

  // From here on: Safaricom says money was taken.
  if (p.status === 'PAID' || p.status === 'AMOUNT_MISMATCH') return null; // already final

  const paid = {
    paidAt: now,
    paidAmount: o.amount ?? null,
    paidCurrency: o.currency ?? null,
    ...(!p.providerRef && o.providerRef ? { providerRef: o.providerRef } : {}),
  };

  // Verify, never assume: a missing amount is a mismatch too.
  if (o.amount !== p.amount || o.currency !== p.currency) {
    return {
      to: 'AMOUNT_MISMATCH',
      event: PaymentEvent.AMOUNT_MISMATCH,
      set: paid,
      detail: {
        expected: `${p.amount} ${p.currency}`,
        received: `${o.amount ?? '?'} ${o.currency ?? '?'}`,
      },
    };
  }

  const duplicate = siblings.some((s) => s.status === 'PAID');
  // Late = the seat hold may be gone: we had given up, or expiresAt has passed.
  const late = p.status !== 'PENDING' || now > p.expiresAt;
  const event = duplicate
    ? PaymentEvent.DUPLICATE
    : late
      ? PaymentEvent.LATE_SUCCEEDED
      : PaymentEvent.SUCCEEDED;

  return {
    to: 'PAID',
    event,
    set: { ...paid, late, duplicate },
    detail: { late, duplicate },
  };
}

/** Expiry: used by the new-attempt rules and the reconciler (Task 6). */
export function decideExpiry(p: Payment): Decision | null {
  return p.status === 'PENDING'
    ? { to: 'EXPIRED', event: PaymentEvent.EXPIRED }
    : null;
}
