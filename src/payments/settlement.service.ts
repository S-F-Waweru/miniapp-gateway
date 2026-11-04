import { Inject, Injectable } from '@nestjs/common';
import type { Payment } from '../generated/prisma/client.js';
import { Alert, AlertService } from '../observability/alert.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderOutcome,
} from '../providers/payment.provider.interface.js';
import {
  PaymentsStore,
  type TransitionResult,
  type TransitionSource,
} from './payments.store.js';
import { decideExpiry, decideOutcome } from './settlement.rules.js';

/** Safaricom could not be reached or answered with an error. Retrying later may help. */
export class ProviderUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`provider unavailable: ${(cause as Error)?.message ?? cause}`);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * Applies facts from Safaricom to payments. Used by notifications, the
 * new-attempt rules, GET refresh, and the reconciler. One place, one behaviour.
 */
@Injectable()
export class SettlementService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private provider: PaymentProvider,
    private store: PaymentsStore,
    private alerts: AlertService,
  ) {}

  async applyOutcome(
    paymentId: string,
    outcome: ProviderOutcome,
    source: TransitionSource,
  ): Promise<TransitionResult> {
    const result = await this.store.transition(
      paymentId,
      source,
      (p, siblings) => decideOutcome(p, siblings, outcome, new Date()),
    );
    // After the commit: never alert about a change that was rolled back.
    if (result.changed) this.alertIfNeedsHuman(result.payment, source);
    return result;
  }

  expire(
    paymentId: string,
    source: TransitionSource,
  ): Promise<TransitionResult> {
    return this.store.transition(paymentId, source, (p) => decideExpiry(p));
  }

  /** Ask Safaricom, then apply. Throws ProviderUnavailableError if Safaricom fails. */
  async inquireAndApply(
    paymentId: string,
    source: TransitionSource,
  ): Promise<TransitionResult> {
    const outcome = await this.callProvider(() =>
      this.provider.inquire(paymentId),
    );
    return this.applyOutcome(paymentId, outcome, source);
  }

  /**
   * Make sure a PENDING payment can no longer take money:
   * ask Safaricom → (paid? settle) → close it (if supported) → mark EXPIRED.
   * Returns the final row: EXPIRED, or PAID/FAILED/AMOUNT_MISMATCH if Safaricom
   * (or a notification racing with us) said otherwise. Never guesses: if
   * Safaricom can't be reached, throws ProviderUnavailableError and changes nothing.
   */
  async retire(paymentId: string, source: TransitionSource): Promise<Payment> {
    const latest = (await this.inquireAndApply(paymentId, source)).payment;
    if (latest.status !== 'PENDING') return latest;

    const close = this.provider.close?.bind(this.provider);
    if (close) await this.callProvider(() => close(paymentId)); // CONFIRM API exists

    // A notification may have landed since the inquiry: the engine re-checks
    // under the lock, so this returns PAID instead of EXPIRED in that case.
    return (await this.expire(paymentId, source)).payment;
  }

  /** Money that arrived in a way the main backend (or finance) must handle. */
  private alertIfNeedsHuman(p: Payment, source: TransitionSource): void {
    const context = {
      paymentId: p.id,
      bookingRef: p.bookingRef,
      amount: p.amount.toString(),
      paidAmount: p.paidAmount?.toString() ?? null,
      currency: p.currency,
      paidCurrency: p.paidCurrency,
      source,
    };
    if (p.status === 'AMOUNT_MISMATCH') {
      this.alerts.raise(Alert.AMOUNT_MISMATCH, 'paid amount differs', context);
    } else if (p.status === 'PAID' && p.duplicate) {
      this.alerts.raise(Alert.DUPLICATE_PAYMENT, 'booking paid twice', context);
    } else if (p.status === 'PAID' && p.late) {
      this.alerts.raise(Alert.LATE_PAYMENT, 'paid after expiry', context);
    }
  }

  private async callProvider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new ProviderUnavailableError(e);
    }
  }
}
