export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';
export type PayStatus = 'PENDING' | 'PAID' | 'FAILED';

export interface CreatePaymentInput {
  orderId: string;
  amount: number;
  currency: string;
  title: string;
  userId?: string;
}

export interface CreatePaymentResult {
  tradeNO?: string;
  paymentUrl?: string;
  providerRef: string;
}

export interface NotifyResult {
  orderId: string;
  status: PayStatus;
  providerRef: string;
  ack: any; // ack = body returned to provider
}

export interface PaymentProvider {
  name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  inquire(orderId: string): Promise<PayStatus>;
  handleNotify(
    headers: Record<string, string>,
    rawBody: string,
    path: string,
  ): Promise<NotifyResult>;
}