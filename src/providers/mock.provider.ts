import { Injectable } from '@nestjs/common';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  ParsedNotification,
  PaymentProvider,
  PayStatus,
  ProviderOutcome,
} from './payment.provider.interface.js';

type Trade = {
  tradeNO: string;
  paymentId: string;
  status: PayStatus;
  amount: bigint;
  currency: string;
  closed: boolean;
};

const ACK = {
  result: {
    resultCode: 'SUCCESS',
    resultStatus: 'S',
    resultMessage: 'success',
  },
};

/** In-memory stand-in for Safaricom. Development and tests only. */
@Injectable()
export class MockProvider implements PaymentProvider {
  name = 'mock';
  private trades = new Map<string, Trade>(); // by tradeNO

  async createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult> {
    const tradeNO = `MOCK${Date.now()}${Math.floor(Math.random() * 1000)}`;
    this.trades.set(tradeNO, {
      tradeNO,
      paymentId: i.paymentId,
      status: 'PENDING',
      amount: i.amount,
      currency: i.currency,
      closed: false,
    });
    return { tradeNO, providerRef: tradeNO };
  }

  async inquire(paymentId: string): Promise<ProviderOutcome> {
    const t = this.byPayment(paymentId);
    if (!t) return { status: 'PENDING' };
    return {
      status: t.status,
      providerRef: t.tradeNO,
      amount: t.amount,
      currency: t.currency,
    };
  }

  async close(paymentId: string): Promise<void> {
    const t = this.byPayment(paymentId);
    if (t) t.closed = true;
  }

  verifyNotification(): boolean {
    return true; // the mock has no signatures
  }

  /** Body: { tradeNO, status, amount?, currency? }. Missing amount = the stored one. */
  parseNotification(raw: string): ParsedNotification {
    const b = JSON.parse(raw);
    const t = this.trades.get(b.tradeNO);
    if (!t) throw new Error(`unknown trade ${b.tradeNO}`);
    t.status = b.status;
    return {
      paymentId: t.paymentId,
      outcome: {
        status: b.status,
        providerRef: t.tradeNO,
        amount: b.amount !== undefined ? BigInt(b.amount) : t.amount,
        currency: b.currency ?? t.currency,
      },
    };
  }

  notifyAck() {
    return ACK;
  }

  private byPayment(paymentId: string): Trade | undefined {
    return [...this.trades.values()].find((t) => t.paymentId === paymentId);
  }
}
