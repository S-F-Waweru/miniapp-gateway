import { Injectable, Logger } from '@nestjs/common';

/**
 * Every situation a human must look at (doc §5.10). A fixed list, so a log
 * platform can alert on `alert = "AMOUNT_MISMATCH"` instead of on free text.
 */
export const Alert = {
  /** A notification failed signature checks: misconfiguration or an attack. */
  INVALID_NOTIFICATION_SIGNATURE: 'INVALID_NOTIFICATION_SIGNATURE',
  /** A verified notification could not be applied (unknown payment, bad body...). */
  NOTIFICATION_REJECTED: 'NOTIFICATION_REJECTED',
  /** Money arrived with a different amount or currency. Never ticketed. */
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  /** Money arrived after we gave up or after expiresAt: the seat may be gone. */
  LATE_PAYMENT: 'LATE_PAYMENT',
  /** A booking was paid twice: one payment must be refunded. */
  DUPLICATE_PAYMENT: 'DUPLICATE_PAYMENT',
  /** An event has been failing to reach the main backend for over 48 h. */
  EVENT_DELIVERY_FAILING: 'EVENT_DELIVERY_FAILING',
  /** Events undelivered for over 15 min. */
  OUTBOX_STALLED: 'OUTBOX_STALLED',
  /** Payments PENDING for over 30 min. */
  PAYMENTS_STUCK_PENDING: 'PAYMENTS_STUCK_PENDING',
} as const;

export type AlertCode = (typeof Alert)[keyof typeof Alert];
export type AlertContext = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * Raises an alert as one structured ERROR log line:
 *   {"level":"error","context":"Alert","message":{"alert":"AMOUNT_MISMATCH","paymentId":...}}
 * With NestJS Observe (or any log platform) wired up, alert rules match on
 * `alert`. Never put secrets or customer data in `context`.
 */
@Injectable()
export class AlertService {
  private readonly log = new Logger('Alert');

  raise(code: AlertCode, message: string, context: AlertContext = {}): void {
    this.log.error({ alert: code, message, ...context });
  }
}
