import { Injectable, NotFoundException } from '@nestjs/common';
import { PaymentProvider, PayStatus } from './payment.provider.interface.js';

@Injectable()
export class MockProvider implements PaymentProvider {
  name = 'mock';
  private trades = new Map<string, { orderId: string; status: PayStatus }>();

  async createPayment(i: { orderId: any }) {
    const tradeNO = `MOCK${Date.now()}`;
    this.trades.set(tradeNO, { orderId: i.orderId, status: 'PENDING' });
    return { tradeNO, providerRef: tradeNO };
  }

  async inquire(orderId: string) {
    return (
      [...this.trades.values()].find((t) => t.orderId === orderId)?.status ??
      'PENDING'
    );
  }

  async handleNotify(_h: any, raw: string) {
    const { tradeNO, status } = JSON.parse(raw);
    const t = this.trades.get(tradeNO);
    if (!t) throw new NotFoundException('trade not found');
    t.status = status;
    return {
      orderId: t.orderId,
      status,
      providerRef: tradeNO,
      ack: {
        result: {
          resultCode: 'SUCCESS',
          resultStatus: 'S',
          resultMessage: 'success',
        },
      },
    };
  }
}
