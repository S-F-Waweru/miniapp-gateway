import { ReconcilerService } from '../src/reconciler/reconciler.service.js';
import type { ProviderOutcome } from '../src/providers/payment.provider.interface.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('reconciler (e2e)', () => {
  let t: TestApp;
  let reconciler: ReconcilerService;

  beforeAll(async () => {
    t = await createTestApp('REC-');
    reconciler = t.app.get(ReconcilerService);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.db.requestNonce.deleteMany({
      where: { nonce: { startsWith: 'REC-' } },
    });
    await t.close();
  });

  const ago = (ms: number) => new Date(Date.now() - ms);
  const MIN = 60_000;

  /** Move a payment back in time. */
  const age = (id: string, data: { createdAt?: Date; expiresAt?: Date }) =>
    t.db.payment.update({ where: { id }, data });

  const status = async (id: string) =>
    (await t.db.payment.findUniqueOrThrow({ where: { id } })).status;

  /** Safaricom answers `answers[paymentId]`, and PENDING for everything else. */
  const safaricomSays = (answers: Record<string, ProviderOutcome | Error>) =>
    vi.spyOn(t.provider, 'inquire').mockImplementation(async (id) => {
      const a = answers[id];
      if (a instanceof Error) throw a;
      return a ?? { status: 'PENDING' };
    });

  const paidOutcome = (tradeNO: string): ProviderOutcome => ({
    status: 'PAID',
    providerRef: tradeNO,
    amount: 1500n,
    currency: 'KES',
  });

  describe('sweepPending (lost notifications)', () => {
    it('asks Safaricom about an old PENDING payment and settles it', async () => {
      const p = await t.newPayment();
      await age(p.paymentId, { createdAt: ago(3 * MIN) });
      safaricomSays({ [p.paymentId]: paidOutcome(p.tradeNO) });

      await reconciler.sweepPending();

      expect(await status(p.paymentId)).toBe('PAID');
      const last = await t.db.paymentTransition.findFirstOrThrow({
        where: { paymentId: p.paymentId },
        orderBy: { id: 'desc' },
      });
      expect(last.source).toBe('reconciler');
      expect(await t.eventTypes(p.paymentId)).toEqual(['payment.succeeded']);
    });

    it('leaves fresh payments alone: the notification may still come', async () => {
      const p = await t.newPayment();
      const inquire = safaricomSays({});
      await reconciler.sweepPending();
      expect(inquire).not.toHaveBeenCalledWith(p.paymentId);
    });

    it('does not ask about the same payment again within its interval', async () => {
      const p = await t.newPayment();
      await age(p.paymentId, { createdAt: ago(3 * MIN) });
      const inquire = safaricomSays({});

      await reconciler.sweepPending();
      await reconciler.sweepPending();

      const calls = inquire.mock.calls.filter(([id]) => id === p.paymentId);
      expect(calls).toHaveLength(1);
    });

    it('one failing inquiry does not stop the others', async () => {
      const a = await t.newPayment();
      const b = await t.newPayment();
      await age(a.paymentId, { createdAt: ago(3 * MIN) });
      await age(b.paymentId, { createdAt: ago(3 * MIN) });
      safaricomSays({
        [a.paymentId]: new Error('timeout'),
        [b.paymentId]: paidOutcome(b.tradeNO),
      });

      const report = await reconciler.sweepPending();

      expect(report.errors).toBeGreaterThanOrEqual(1);
      expect(await status(a.paymentId)).toBe('PENDING'); // unknown stays unknown
      expect(await status(b.paymentId)).toBe('PAID');
    });
  });

  describe('expireOverdue', () => {
    it('unpaid and overdue → closed at Safaricom, EXPIRED, event written', async () => {
      const p = await t.newPayment();
      await age(p.paymentId, {
        createdAt: ago(20 * MIN),
        expiresAt: ago(3 * MIN),
      });
      safaricomSays({});
      const close = vi.spyOn(t.provider, 'close');

      await reconciler.expireOverdue();

      expect(close).toHaveBeenCalledWith(p.paymentId);
      expect(await status(p.paymentId)).toBe('EXPIRED');
      expect(await t.eventTypes(p.paymentId)).toEqual(['payment.expired']);
    });

    it('overdue but actually paid → PAID (late), never EXPIRED', async () => {
      const p = await t.newPayment();
      await age(p.paymentId, {
        createdAt: ago(20 * MIN),
        expiresAt: ago(3 * MIN),
      });
      safaricomSays({ [p.paymentId]: paidOutcome(p.tradeNO) });

      await reconciler.expireOverdue();

      const row = await t.db.payment.findUniqueOrThrow({
        where: { id: p.paymentId },
      });
      expect(row).toMatchObject({ status: 'PAID', late: true });
    });

    it('Safaricom unreachable → left PENDING (never expire on a guess)', async () => {
      const p = await t.newPayment();
      await age(p.paymentId, {
        createdAt: ago(20 * MIN),
        expiresAt: ago(3 * MIN),
      });
      safaricomSays({ [p.paymentId]: new Error('timeout') });

      await reconciler.expireOverdue();

      expect(await status(p.paymentId)).toBe('PENDING');
    });

    it('within the 2-minute grace period → untouched', async () => {
      const p = await t.newPayment();
      await age(p.paymentId, { createdAt: ago(20 * MIN), expiresAt: ago(MIN) });
      const inquire = safaricomSays({});

      await reconciler.expireOverdue();

      expect(inquire).not.toHaveBeenCalledWith(p.paymentId);
      expect(await status(p.paymentId)).toBe('PENDING');
    });
  });

  it('checkHealth reports stalled events and stuck payments', async () => {
    const stuck = await t.newPayment();
    await age(stuck.paymentId, { createdAt: ago(40 * MIN) });

    const paid = await t.newPayment();
    await t.mockPay(paid.tradeNO).expect(200);
    await t.db.outboxEvent.updateMany({
      where: { paymentId: paid.paymentId },
      data: { createdAt: ago(20 * MIN) }, // jobs are off, so it was never delivered
    });

    const report = await reconciler.checkHealth();

    expect(report.stuckPayments).toBeGreaterThanOrEqual(1);
    expect(report.stalledEvents).toBeGreaterThanOrEqual(1);
    expect(report.oldestStalledEventAt).not.toBeNull();
  });

  it('cleanupNonces removes only expired nonces', async () => {
    await t.db.requestNonce.createMany({
      data: [
        { nonce: 'REC-old', expiresAt: ago(MIN) },
        { nonce: 'REC-new', expiresAt: new Date(Date.now() + 10 * MIN) },
      ],
    });

    await reconciler.cleanupNonces();

    const left = await t.db.requestNonce.findMany({
      where: { nonce: { startsWith: 'REC-' } },
    });
    expect(left.map((n) => n.nonce)).toEqual(['REC-new']);
  });
});
