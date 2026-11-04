import { Injectable, NotFoundException } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Payment } from '../generated/prisma/client.js';
import { eventPayload } from './events.js';
import { ALLOWED, type Decision } from './settlement.rules.js';

export type NewPayment = {
  id: string;
  bookingRef: string;
  idempotencyKey: string;
  requestHash: string;
  amount: bigint; // whole shillings
  currency: string;
  title: string;
  customerRef?: string;
  expiresAt: Date;
};

export type TransitionSource = 'api' | 'notify' | 'inquiry' | 'reconciler';
export type TransitionResult = { payment: Payment; changed: boolean };

/** All database access for payments. Services never touch Prisma directly. */
@Injectable()
export class PaymentsStore {
  constructor(private db: PrismaService) {}

  findById(id: string) {
    return this.db.payment.findUnique({ where: { id } });
  }

  findByIdempotencyKey(idempotencyKey: string) {
    return this.db.payment.findUnique({ where: { idempotencyKey } });
  }

  findOpenForBooking(bookingRef: string) {
    return this.db.payment.findFirst({
      where: { bookingRef, status: 'PENDING' },
    });
  }

  findPaidForBooking(bookingRef: string) {
    return this.db.payment.findFirst({
      where: { bookingRef, status: 'PAID' },
      orderBy: { paidAt: 'asc' },
    });
  }

  listByBooking(bookingRef: string) {
    return this.db.payment.findMany({
      where: { bookingRef },
      orderBy: { attempt: 'desc' },
    });
  }

  /**
   * Inserts the next attempt and its first audit row atomically.
   * Throws P2002 if a parallel request won: same idempotency key,
   * same attempt number, or another PENDING payment for the booking.
   */
  insert(p: NewPayment): Promise<Payment> {
    return this.db.$transaction(async (tx) => {
      const last = await tx.payment.findFirst({
        where: { bookingRef: p.bookingRef },
        orderBy: { attempt: 'desc' },
        select: { attempt: true },
      });
      const payment = await tx.payment.create({
        data: { ...p, attempt: (last?.attempt ?? 0) + 1 },
      });
      await tx.paymentTransition.create({
        data: {
          paymentId: payment.id,
          from: null,
          to: 'PENDING',
          source: 'api',
        },
      });
      return payment;
    });
  }

  setProviderResult(
    id: string,
    r: { providerRef: string; tradeNO?: string; paymentUrl?: string },
  ): Promise<Payment> {
    return this.db.payment.update({
      where: { id },
      data: {
        providerRef: r.providerRef,
        tradeNO: r.tradeNO ?? null,
        paymentUrl: r.paymentUrl ?? null,
      },
    });
  }

  /** Reconciler: PENDING payments created before `createdBefore`, least recently checked first. */
  findPendingForSweep(createdBefore: Date, limit: number) {
    return this.db.payment.findMany({
      where: { status: 'PENDING', createdAt: { lt: createdBefore } },
      orderBy: [
        { lastInquiryAt: { sort: 'asc', nulls: 'first' } },
        { id: 'asc' },
      ],
      take: limit,
    });
  }

  /** Reconciler: PENDING payments whose expiresAt is before `expiredBefore`. */
  findOverdue(expiredBefore: Date, limit: number) {
    return this.db.payment.findMany({
      where: { status: 'PENDING', expiresAt: { lt: expiredBefore } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Claims the right to ask Safaricom about a PENDING payment, at most once per
   * `minIntervalMs` (counted from the last inquiry, or from creation).
   * One conditional UPDATE: of N parallel callers, exactly one gets `true`.
   */
  async claimInquiry(id: string, minIntervalMs: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - minIntervalMs);
    const { count } = await this.db.payment.updateMany({
      where: {
        id,
        status: 'PENDING',
        OR: [
          { lastInquiryAt: null, createdAt: { lt: cutoff } },
          { lastInquiryAt: { lt: cutoff } },
        ],
      },
      data: { lastInquiryAt: new Date() },
    });
    return count === 1;
  }

  /**
   * The ONLY way a payment's status changes.
   * One transaction: lock the booking → decide → update + audit row + outbox event.
   * `decide` runs inside the lock, so it always sees the latest committed state.
   */
  transition(
    paymentId: string,
    source: TransitionSource,
    decide: (p: Payment, siblings: Payment[]) => Decision | null,
  ): Promise<TransitionResult> {
    return this.db.$transaction(async (tx) => {
      const head = await tx.payment.findUnique({
        where: { id: paymentId },
        select: { bookingRef: true },
      });
      if (!head) throw new NotFoundException(`payment ${paymentId} not found`);

      // Lock every attempt of the booking, always in id order (prevents deadlocks).
      // A second transition for this booking WAITS here until we commit.
      await tx.$queryRaw`
        SELECT id FROM "Payment"
        WHERE "bookingRef" = ${head.bookingRef}
        ORDER BY id
        FOR UPDATE`;

      // Read AFTER the lock: this is the latest committed state.
      const booking = await tx.payment.findMany({
        where: { bookingRef: head.bookingRef },
      });
      const current = booking.find((b) => b.id === paymentId)!;

      const decision = decide(
        current,
        booking.filter((b) => b.id !== paymentId),
      );
      if (!decision) return { payment: current, changed: false };

      if (!ALLOWED[current.status].includes(decision.to)) {
        throw new Error(
          `illegal transition ${current.status} → ${decision.to} (${paymentId})`,
        );
      }

      const payment = await tx.payment.update({
        where: { id: paymentId },
        data: { status: decision.to, ...decision.set },
      });

      await tx.paymentTransition.create({
        data: {
          paymentId,
          from: current.status,
          to: decision.to,
          source,
          detail: decision.detail,
        },
      });

      const eventId = `evt_${uuidv7().replaceAll('-', '')}`;
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          paymentId,
          type: decision.event,
          payload: eventPayload(eventId, decision.event, payment, new Date()),
        },
      });

      return { payment, changed: true };
    });
  }
}
