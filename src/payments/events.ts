import type { Payment } from '../generated/prisma/client.js';

export const PaymentEvent = {
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
  EXPIRED: 'payment.expired',
  LATE_SUCCEEDED: 'payment.late_succeeded',
  DUPLICATE: 'payment.duplicate',
  AMOUNT_MISMATCH: 'payment.amount_mismatch',
} as const;

export type PaymentEventType = (typeof PaymentEvent)[keyof typeof PaymentEvent];

/**
 * The body POSTed to the main backend (doc §3.2). Built from the row AFTER the
 * update and stored with the event: a snapshot of what was true at that moment.
 */
export function eventPayload(
  eventId: string,
  type: PaymentEventType,
  p: Payment,
  occurredAt: Date,
) {
  return {
    eventId,
    type,
    paymentId: p.id,
    bookingRef: p.bookingRef,
    attempt: p.attempt,
    amount: p.amount.toString(),
    currency: p.currency,
    paidAmount: p.paidAmount === null ? null : p.paidAmount.toString(),
    paidCurrency: p.paidCurrency,
    providerRef: p.providerRef,
    late: p.late,
    duplicate: p.duplicate,
    occurredAt: occurredAt.toISOString(),
  };
}
