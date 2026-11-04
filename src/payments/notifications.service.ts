import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  type ParsedNotification,
  type PaymentProvider,
} from '../providers/payment.provider.interface.js';
import { Alert, AlertService } from '../observability/alert.service.js';
import { NotificationInbox } from './notification-inbox.store.js';
import { PaymentsStore } from './payments.store.js';
import { SettlementService } from './settlement.service.js';

/**
 * POST /payments/notify (doc §5.3).
 *
 *   verify → store in inbox → (already done? ack) → parse → find payment
 *   → apply via the settlement engine → mark processed → ack
 *
 * Acknowledge only after the DB commit. Throw (→ 5xx → Safaricom retries) only
 * when retrying can help; permanent problems are recorded and acknowledged.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private provider: PaymentProvider,
    private inbox: NotificationInbox,
    private store: PaymentsStore,
    private settlement: SettlementService,
    private alerts: AlertService,
  ) {}

  async handle(headers: Record<string, string>, raw: string, path: string) {
    // 1. Check, but don't act yet: even forged notifications are evidence.
    const signatureValid = this.provider.verifyNotification(headers, raw, path);

    // 2. Write it down first.
    const entry = await this.inbox.record({
      rawBody: raw,
      headers,
      signatureValid,
    });

    if (!signatureValid) {
      this.alerts.raise(
        Alert.INVALID_NOTIFICATION_SIGNATURE,
        'notification failed signature/freshness checks',
        { inboxId: entry.id.toString() },
      );
      throw new UnauthorizedException();
    }

    // 3. Exact replay of something already handled.
    if (entry.alreadyProcessed) return this.provider.notifyAck();

    // 4. Permanent problems: record, alert, acknowledge (a retry would fail the same way).
    let n: ParsedNotification;
    try {
      n = this.provider.parseNotification(raw);
    } catch (e) {
      return this.reject(entry.id, `unparseable: ${(e as Error).message}`);
    }

    const payment = await this.store.findById(n.paymentId);
    if (!payment) {
      return this.reject(entry.id, `unknown paymentRequestId ${n.paymentId}`);
    }
    const ref = n.outcome.providerRef;
    if (payment.providerRef && ref && payment.providerRef !== ref) {
      return this.reject(
        entry.id,
        `providerRef mismatch: stored ${payment.providerRef}, got ${ref}`,
        payment.id,
      );
    }

    // 5. Apply. A DB error here throws → 5xx → Safaricom retries → step 2 finds
    //    the row unprocessed → we try again. The engine makes the retry safe.
    try {
      await this.settlement.applyOutcome(payment.id, n.outcome, 'notify');
    } catch (e) {
      await this.inbox
        .markError(entry.id, (e as Error).message)
        .catch(() => undefined); // don't hide the original error
      throw e;
    }

    // 6. Done. A crash between 5 and 6 is fine: the retry re-applies, which is a no-op.
    await this.inbox.markProcessed(entry.id, {
      paymentId: payment.id,
      providerRef: ref,
    });
    return this.provider.notifyAck();
  }

  private async reject(id: bigint, error: string, paymentId?: string) {
    this.alerts.raise(Alert.NOTIFICATION_REJECTED, error, {
      inboxId: id.toString(),
      paymentId,
    });
    await this.inbox.markProcessed(id, { paymentId, error });
    return this.provider.notifyAck();
  }
}
