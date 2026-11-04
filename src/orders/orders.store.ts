import { Injectable } from '@nestjs/common';
import { PayStatus } from '../providers/payment.provider.interface.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Order as OrderRow } from '../generated/prisma/client.js';

export type Order = {
  id: string;
  amount: number;
  currency: string;
  title: string;
  userId?: string;
  status: PayStatus;
  providerRef?: string;
  createdAt: Date;
  updatedAt: Date;
};

const toOrder = (r: OrderRow): Order => ({
  ...r,
  amount: r.amount.toNumber(),
  userId: r.userId ?? undefined,
  providerRef: r.providerRef ?? undefined,
});

@Injectable()
export class OrdersStore {
  constructor(private db: PrismaService) {}

  async create(o: {
    id: string;
    amount: number;
    currency: string;
    title: string;
    userId?: string;
  }): Promise<Order> {
    return toOrder(await this.db.order.create({ data: o }));
  }

  async get(id: string): Promise<Order | undefined> {
    const r = await this.db.order.findUnique({ where: { id } });
    return r ? toOrder(r) : undefined;
  }

  async setProviderRef(id: string, providerRef: string): Promise<void> {
    await this.db.order.update({ where: { id }, data: { providerRef } });
  }

  /**
   * Moves an order out of PENDING exactly once. The status check happens in the
   * same UPDATE, so concurrent or repeated notifications can't overwrite a final status.
   * Returns true if this call changed the order.
   */
  async settleIfPending(id: string, status: PayStatus): Promise<boolean> {
    if (status === 'PENDING') return false;
    const { count } = await this.db.order.updateMany({
      where: { id, status: 'PENDING' },
      data: { status },
    });
    return count === 1;
  }
}
