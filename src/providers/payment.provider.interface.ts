export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

/** Status from the provider's point of view. */
export type PayStatus = 'PENDING' | 'PAID' | 'FAILED';

/** What the provider told us about one payment (from a notification or an inquiry). */
export interface ProviderOutcome {
  status: PayStatus;
  providerRef?: string;
  amount?: bigint; // whole shillings actually paid; missing = can't verify = mismatch
  currency?: string;
}

export interface ParsedNotification {
  paymentId: string; // our id (paymentRequestId)
  outcome: ProviderOutcome;
}

export interface CreatePaymentInput {
  paymentId: string; // sent as paymentRequestId
  amount: bigint; // whole shillings
  currency: string;
  title: string;
  expiresAt: Date;
}

export interface CreatePaymentResult {
  providerRef: string;
  tradeNO?: string;
  paymentUrl?: string;
}

export interface PaymentProvider {
  name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  inquire(paymentId: string): Promise<ProviderOutcome>;
  /** Stop a payment from being payable. Optional: CONFIRM Safaricom has a close API. */
  close?(paymentId: string): Promise<void>;

  // Notifications are split in three so the inbox can store a notification
  // BEFORE trusting or parsing it.
  verifyNotification(
    headers: Record<string, string>,
    rawBody: string,
    path: string,
  ): boolean;
  parseNotification(rawBody: string): ParsedNotification;
  notifyAck(): unknown;
}
