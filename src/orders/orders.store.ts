import { Injectable } from '@nestjs/common';
import { PayStatus } from '../providers/payment.provider.interface.js';

export type Order = {
  id: string;
  amount: number;
  title: string;
  status: PayStatus;
  providerRef?: string;
};

@Injectable()
export class OrdersStore {
  private m = new Map<string, Order>();
  save(o: Order) {
    this.m.set(o.id, o);
    return o;
  }
  get(id: string) {
    return this.m.get(id);
  }
}
