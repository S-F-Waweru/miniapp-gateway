import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import * as paymentProviderInterface from '../providers/payment.provider.interface.js';
import { OrdersStore } from '../orders/orders.store.js';

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(paymentProviderInterface.PAYMENT_PROVIDER)
    private provider: paymentProviderInterface.PaymentProvider,
    private orders: OrdersStore,
  ) {}

  async createOrder(amount: number, title: string, userId?: string) {
    const order = await this.orders.create({
      id: uuid().replace(/-/g, ''),
      amount,
      currency: 'KES',
      title,
      userId,
    });
    const result = await this.provider.createPayment({
      orderId: order.id,
      amount,
      currency: order.currency,
      title,
      userId,
    });
    await this.orders.setProviderRef(order.id, result.providerRef);
    return {
      orderId: order.id,
      tradeNO: result.tradeNO,
      paymentUrl: result.paymentUrl,
      provider: this.provider.name,
    };
  }

  async status(id: string) {
    const order = await this.orders.get(id);
    if (!order) throw new NotFoundException();
    if (order.status === 'PENDING') {
      // Fallback if the notify was missed
      const status = await this.provider.inquire(id);
      if (await this.orders.settleIfPending(id, status)) order.status = status;
    }
    return order;
  }

  async notify(headers: any, raw: string, path: string) {
    const result = await this.provider.handleNotify(headers, raw, path);
    await this.orders.settleIfPending(result.orderId, result.status); // idempotent
    return result.ack;
  }
}
