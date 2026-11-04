import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v7 as uuidv7 } from 'uuid';
import type { Payment } from '../generated/prisma/client.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../providers/payment.provider.interface.js';
import type { CreatePaymentDto } from './dto/create-payment.dto.js';
import { toView, type PaymentView } from './payment-view.js';
import { requestHash } from './request-hash.js';
import { PaymentsStore } from './payments.store.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import {
  ProviderUnavailableError,
  SettlementService,
} from './settlement.service.js';

// Longer than the axios timeout (10 s): a key with no providerRef younger than
// this may still have its Safaricom call in flight.
const IN_FLIGHT_MS = 15_000;

// GET /v1/payments/:id asks Safaricom about a PENDING payment at most this often.
const INQUIRY_INTERVAL_MS = 15_000;

export type CreateOutcome = { created: boolean; payment: PaymentView };

@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);
  private readonly maxTtlMs: number;

  constructor(
    @Inject(PAYMENT_PROVIDER) private provider: PaymentProvider,
    private store: PaymentsStore,
    private settlement: SettlementService,
    cfg: ConfigService,
  ) {
    this.maxTtlMs =
      Number(cfg.getOrThrow<string>('PAYMENT_MAX_TTL_MINUTES')) * 60_000;
  }

  async create(
    input: CreatePaymentDto,
    idempotencyKey: string,
  ): Promise<CreateOutcome> {
    const hash = requestHash(input);

    // 1. Seen this key before? Replays are answered before any other rule,
    //    so a retry gets the original answer even if the world changed since.
    const existing = await this.store.findByIdempotencyKey(idempotencyKey);
    if (existing) return this.replay(existing, hash);

    // 2. Rules the DTO can't express.
    const expiresAt = new Date(input.expiresAt);
    const now = Date.now();
    if (expiresAt.getTime() <= now) {
      throw new UnprocessableEntityException({ code: 'EXPIRES_AT_IN_PAST' });
    }
    if (expiresAt.getTime() > now + this.maxTtlMs) {
      throw new UnprocessableEntityException({ code: 'EXPIRES_AT_TOO_FAR' });
    }

    // 3. Paid bookings are closed.
    const paid = await this.store.findPaidForBooking(input.bookingRef);
    if (paid) {
      throw new ConflictException({
        code: 'BOOKING_ALREADY_PAID',
        paymentId: paid.id,
      });
    }

    // 4. An earlier attempt still open? Replace it only once it is truly dead.
    const open = await this.store.findOpenForBooking(input.bookingRef);
    if (open) await this.retireOpenAttempt(open);

    // 5. Insert. Races are decided by the database, not by the checks above.
    let payment: Payment;
    try {
      payment = await this.store.insert({
        id: `pay_${uuidv7().replaceAll('-', '')}`,
        bookingRef: input.bookingRef,
        idempotencyKey,
        requestHash: hash,
        amount: BigInt(input.amount),
        currency: input.currency,
        title: input.title,
        customerRef: input.customerRef,
        expiresAt,
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return this.resolveInsertRace(input.bookingRef, idempotencyKey, hash);
    }

    // 6. Network call, outside any DB transaction.
    return { created: true, payment: await this.callProvider(payment) };
  }

  /** Stored state, refreshed from Safaricom if PENDING and not asked recently. */
  async get(id: string): Promise<PaymentView> {
    let p = await this.store.findById(id);
    if (!p) throw new NotFoundException();
    if (
      p.status === 'PENDING' &&
      (await this.store.claimInquiry(p.id, INQUIRY_INTERVAL_MS))
    ) {
      try {
        p = (await this.settlement.inquireAndApply(p.id, 'inquiry')).payment;
      } catch (e) {
        // A read must not fail because Safaricom is slow: serve what we know.
        this.log.warn(`inquiry for ${p.id} failed: ${(e as Error).message}`);
      }
    }
    return toView(p);
  }

  async listByBooking(bookingRef: string): Promise<PaymentView[]> {
    return (await this.store.listByBooking(bookingRef)).map(toView);
  }

  // ---------------------------------------------------------------------------

  private async replay(p: Payment, hash: string): Promise<CreateOutcome> {
    if (p.requestHash !== hash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        paymentId: p.id,
      });
    }
    // Safaricom never answered for this payment (earlier 502). Retry with the same
    // paymentRequestId, unless the first call may still be running.
    if (p.status === 'PENDING' && !p.providerRef) {
      if (Date.now() - p.createdAt.getTime() < IN_FLIGHT_MS) {
        throw new ConflictException({
          code: 'REQUEST_IN_PROGRESS',
          paymentId: p.id,
        });
      }
      return { created: false, payment: await this.callProvider(p) };
    }
    return { created: false, payment: toView(p) };
  }

  /**
   * New-attempt rule (doc §5.1.4): attempt N+1 may only be created once attempt N
   * can no longer take money. While N is within its expiry the caller should reuse
   * it. After expiry, SettlementService.retire() asks Safaricom, closes and expires
   * it. Any doubt → refuse, never guess.
   */
  private async retireOpenAttempt(open: Payment): Promise<void> {
    if (Date.now() < open.expiresAt.getTime()) {
      throw new ConflictException({
        code: 'PAYMENT_IN_PROGRESS',
        paymentId: open.id,
      });
    }

    let latest: Payment;
    try {
      latest = await this.settlement.retire(open.id, 'api');
    } catch (e) {
      if (!(e instanceof ProviderUnavailableError)) throw e; // DB error → 500
      this.log.error(`retiring ${open.id} failed: ${e.message}`);
      throw new BadGatewayException({
        code: 'PROVIDER_UNAVAILABLE',
        paymentId: open.id,
      });
    }

    if (latest.status === 'PAID') {
      throw new ConflictException({
        code: 'BOOKING_ALREADY_PAID',
        paymentId: latest.id,
      });
    }
    if (latest.status === 'AMOUNT_MISMATCH') {
      throw new ConflictException({
        code: 'PAYMENT_UNDER_REVIEW',
        paymentId: latest.id,
      });
    }
    // FAILED or EXPIRED: the slot is free.
  }

  /** We lost an insert race. Re-read to find out to whom, instead of parsing the error. */
  private async resolveInsertRace(
    bookingRef: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<CreateOutcome> {
    const sameKey = await this.store.findByIdempotencyKey(idempotencyKey);
    if (sameKey) return this.replay(sameKey, hash);

    const open = await this.store.findOpenForBooking(bookingRef);
    if (open) {
      throw new ConflictException({
        code: 'PAYMENT_IN_PROGRESS',
        paymentId: open.id,
      });
    }
    // Lost an attempt-number race to a payment that already settled. Safe to retry.
    throw new ConflictException({ code: 'CONCURRENT_REQUEST' });
  }

  private async callProvider(p: Payment): Promise<PaymentView> {
    try {
      const r = await this.provider.createPayment({
        paymentId: p.id,
        amount: p.amount,
        currency: p.currency,
        title: p.title,
        expiresAt: p.expiresAt,
      });
      return toView(await this.store.setProviderResult(p.id, r));
    } catch (e) {
      // Outcome UNKNOWN: Safaricom may have created it before the timeout.
      // Never mark FAILED here. Stay PENDING; a same-key retry or the reconciler resolves it.
      this.log.error(`pay call failed for ${p.id}: ${(e as Error).message}`);
      throw new BadGatewayException({
        code: 'PROVIDER_UNAVAILABLE',
        paymentId: p.id,
      });
    }
  }
}
