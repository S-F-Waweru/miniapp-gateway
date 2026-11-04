import type { Payment } from '../generated/prisma/client.js';

/** The public shape of a payment. Internal columns (requestHash, idempotencyKey) never leave. */
export function toView(p: Payment) {
  return {
    paymentId: p.id,
    bookingRef: p.bookingRef,
    attempt: p.attempt,
    status: p.status,
    amount: p.amount.toString(), // same format the main backend sent: "1500"
    currency: p.currency,
    tradeNO: p.tradeNO,
    paymentUrl: p.paymentUrl,
    expiresAt: p.expiresAt.toISOString(),
    paidAt: p.paidAt?.toISOString() ?? null,
    late: p.late,
    duplicate: p.duplicate,
  };
}

export type PaymentView = ReturnType<typeof toView>;
