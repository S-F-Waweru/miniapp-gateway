import type { MockInstance } from 'vitest';
import { AlertService } from '../src/observability/alert.service.js';
import { ReconcilerService } from '../src/reconciler/reconciler.service.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('health and alerts (e2e)', () => {
  let t: TestApp;
  let raise: MockInstance<AlertService['raise']>;

  beforeAll(async () => {
    t = await createTestApp('OBS-');
  });
  beforeEach(() => {
    raise = vi.spyOn(t.app.get(AlertService), 'raise');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => t.close());

  /** Alert codes raised for one payment. */
  const alertsFor = (paymentId: string) =>
    raise.mock.calls
      .filter(([, , ctx]) => ctx?.paymentId === paymentId)
      .map(([code]) => code);

  it('GET /health is public and checks the database', async () => {
    const res = await t.http().get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('a normal payment raises no alert', async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO).expect(200);
    expect(alertsFor(p.paymentId)).toEqual([]);
  });

  it('wrong amount → AMOUNT_MISMATCH alert', async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO, { amount: '15' }).expect(200);
    expect(alertsFor(p.paymentId)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('money after FAILED → LATE_PAYMENT alert', async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO, { status: 'FAILED' }).expect(200);
    await t.mockPay(p.tradeNO).expect(200);
    expect(alertsFor(p.paymentId)).toEqual(['LATE_PAYMENT']);
  });

  it('booking paid twice → DUPLICATE_PAYMENT alert', async () => {
    const ref = t.booking();
    const a1 = await t.newPayment(ref);
    await t.mockPay(a1.tradeNO, { status: 'FAILED' }).expect(200);
    const a2 = await t.newPayment(ref);
    await t.mockPay(a2.tradeNO).expect(200);
    await t.mockPay(a1.tradeNO).expect(200);
    expect(alertsFor(a1.paymentId)).toEqual(['DUPLICATE_PAYMENT']);
  });

  it('forged notification → INVALID_NOTIFICATION_SIGNATURE alert', async () => {
    const p = await t.newPayment();
    vi.spyOn(t.provider, 'verifyNotification').mockReturnValue(false);
    await t.mockPay(p.tradeNO).expect(401);
    expect(raise.mock.calls.map(([code]) => code)).toContain(
      'INVALID_NOTIFICATION_SIGNATURE',
    );
  });

  it('health job → OUTBOX_STALLED and PAYMENTS_STUCK_PENDING alerts', async () => {
    const p = await t.newPayment();
    await t.db.payment.update({
      where: { id: p.paymentId },
      data: { createdAt: new Date(Date.now() - 40 * 60_000) },
    });
    const q = await t.newPayment();
    await t.mockPay(q.tradeNO).expect(200);
    await t.db.outboxEvent.updateMany({
      where: { paymentId: q.paymentId },
      data: { createdAt: new Date(Date.now() - 20 * 60_000) },
    });

    await t.app.get(ReconcilerService).checkHealth();

    const codes = raise.mock.calls.map(([code]) => code);
    expect(codes).toContain('OUTBOX_STALLED');
    expect(codes).toContain('PAYMENTS_STUCK_PENDING');
  });
});
