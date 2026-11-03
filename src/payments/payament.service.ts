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
    const order = this.orders.save({
      id: uuid().replace(/-/g, ''),
      amount,
      title,
      status: 'PENDING',
    });
    const result = await this.provider.createPayment({
      orderId: order.id,
      amount,
      currency: 'KES',
      title,
      userId,
    });
    order.providerRef = result.providerRef;
    return {
      orderId: order.id,
      tradeNO: result.tradeNO,
      paymentUrl: result.paymentUrl,
      provider: this.provider.name,
    };
  }

  async status(id: string) {
    const order = this.orders.get(id);
    if (!order) throw new NotFoundException();
    if (order.status === 'PENDING')
      order.status = await this.provider.inquire(id); // fallback if notify missed
    return order;
  }

  async notify(headers: any, raw: string, path: string) {
    const result = await this.provider.handleNotify(headers, raw, path);
    const order = this.orders.get(result.orderId);
    if (order && order.status === 'PENDING') order.status = result.status; // idempotent
    return result.ack;
  }
}
