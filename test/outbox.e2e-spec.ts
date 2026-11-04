import { OutboxDispatcher } from '../src/outbox/outbox.dispatcher.js';
import { startFakeBackend } from './support/fake-backend.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const EVENT_KEY = 'e2e-event-signing-key-0123456789abcdef';

describe('outbox dispatcher (e2e)', () => {
  let backend: Awaited<ReturnType<typeof startFakeBackend>>;
  let t: TestApp;
  let dispatcher: OutboxDispatcher;

  beforeAll(async () => {
    backend = await startFakeBackend(EVENT_KEY);
    t = await createTestApp('OUT-', {
      MAIN_BACKEND_EVENTS_URL: backend.url,
      EVENT_HMAC_KEY: EVENT_KEY,
    });
    dispatcher = t.app.get(OutboxDispatcher);
  });
  afterAll(async () => {
    await t.close();
    await backend.close();
  });

  const events = (paymentId: string) =>
    t.db.outboxEvent.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'asc' },
    });

  /** Pretend the retry wait is over. */
  const makeDue = (paymentId: string) =>
    t.db.outboxEvent.updateMany({
      where: { paymentId, deliveredAt: null },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

  const paidPayment = async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO).expect(200);
    return p;
  };

  it('delivers a signed event once and marks it delivered', async () => {
    const p = await paidPayment();

    await dispatcher.dispatchOnce();

    const got = backend.forPayment(p.paymentId);
    expect(got).toHaveLength(1);
    expect(got[0].signatureValid).toBe(true);
    expect(got[0].headers['x-client-id']).toBe('miniapp-gateway');
    expect(got[0].headers['x-gateway-event-id']).toBe(got[0].event.eventId);
    expect(got[0].event).toMatchObject({
      type: 'payment.succeeded',
      paymentId: p.paymentId,
      bookingRef: p.bookingRef,
      amount: '1500',
    });

    const [row] = await events(p.paymentId);
    expect(row.deliveredAt).not.toBeNull();
    expect(row.attempts).toBe(1);

    await dispatcher.dispatchOnce(); // nothing left to send
    expect(backend.forPayment(p.paymentId)).toHaveLength(1);
  });

  it('backend error → retried after a backoff, then delivered (same eventId)', async () => {
    const p = await paidPayment();
    backend.failFor(p.paymentId, 1);

    await dispatcher.dispatchOnce();
    let [row] = await events(p.paymentId);
    expect(row.deliveredAt).toBeNull();
    expect(row.lastError).toBe('HTTP 500');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 3_000); // ~5 s backoff

    await dispatcher.dispatchOnce(); // not due yet: nothing sent
    expect(backend.forPayment(p.paymentId)).toHaveLength(1);

    await makeDue(p.paymentId);
    await dispatcher.dispatchOnce();
    [row] = await events(p.paymentId);
    expect(row.deliveredAt).not.toBeNull();
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBeNull();

    const ids = backend.forPayment(p.paymentId).map((r) => r.event.eventId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1); // a retry is the SAME event: receiver dedupes on it
  });

  it("one payment's events arrive in order, even when the first one fails", async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO, { status: 'FAILED' }).expect(200);
    await t.mockPay(p.tradeNO, { status: 'PAID' }).expect(200); // late money
    backend.failFor(p.paymentId, 1);

    await dispatcher.dispatchOnce(); // "failed" → 500; "late_succeeded" must wait
    await makeDue(p.paymentId);
    await dispatcher.dispatchOnce(); // "failed" delivered
    await dispatcher.dispatchOnce(); // now "late_succeeded" may go

    expect(backend.forPayment(p.paymentId).map((r) => r.event.type)).toEqual([
      'payment.failed',
      'payment.failed',
      'payment.late_succeeded',
    ]);
  });

  it('dispatchers running at the same time never send an event twice', async () => {
    const ps = [await paidPayment(), await paidPayment(), await paidPayment()];

    await Promise.all([
      dispatcher.dispatchOnce(),
      dispatcher.dispatchOnce(),
      dispatcher.dispatchOnce(),
    ]);

    for (const p of ps) {
      expect(backend.forPayment(p.paymentId)).toHaveLength(1);
    }
  });
});
