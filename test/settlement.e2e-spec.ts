import { createTestApp, type TestApp } from './support/test-app.js';

describe('settlement engine (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp('SET-');
  });
  afterAll(() => t.close());

  it('5 parallel identical notifications → exactly one transition and one event', async () => {
    const p = await t.newPayment();
    await Promise.all(
      Array.from({ length: 5 }, () => t.mockPay(p.tradeNO).expect(200)),
    );

    expect(await t.history(p.paymentId)).toEqual([
      'null→PENDING',
      'PENDING→PAID',
    ]);
    expect(await t.eventTypes(p.paymentId)).toEqual(['payment.succeeded']);
  });

  it('wrong amount → AMOUNT_MISMATCH, never payment.succeeded', async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO, { amount: '15' }).expect(200);

    const row = await t.db.payment.findUniqueOrThrow({
      where: { id: p.paymentId },
    });
    expect(row.status).toBe('AMOUNT_MISMATCH');
    expect(row.paidAmount).toBe(15n);
    expect(await t.eventTypes(p.paymentId)).toEqual([
      'payment.amount_mismatch',
    ]);
  });

  it('FAILED then a late SUCCESS → PAID late, money is not lost', async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO, { status: 'FAILED' }).expect(200);
    await t.mockPay(p.tradeNO, { status: 'PAID' }).expect(200);

    const row = await t.db.payment.findUniqueOrThrow({
      where: { id: p.paymentId },
    });
    expect(row.status).toBe('PAID');
    expect(row.late).toBe(true);
    expect(await t.eventTypes(p.paymentId)).toEqual([
      'payment.failed',
      'payment.late_succeeded',
    ]);
  });

  it('a "still processing" notification changes nothing', async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO, { status: 'PENDING' }).expect(200);
    expect(await t.history(p.paymentId)).toEqual(['null→PENDING']);
  });

  it('FAILED after PAID is ignored', async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO, { status: 'PAID' }).expect(200);
    await t.mockPay(p.tradeNO, { status: 'FAILED' }).expect(200);
    expect(await t.history(p.paymentId)).toEqual([
      'null→PENDING',
      'PENDING→PAID',
    ]);
  });

  it('attempt 1 paid late after attempt 2 was paid → duplicate', async () => {
    const ref = t.booking();
    const a1 = await t.newPayment(ref);
    await t.mockPay(a1.tradeNO, { status: 'FAILED' }).expect(200);
    const a2 = await t.newPayment(ref);
    await t.mockPay(a2.tradeNO).expect(200);

    await t.mockPay(a1.tradeNO).expect(200); // money for attempt 1 arrives anyway

    const row = await t.db.payment.findUniqueOrThrow({
      where: { id: a1.paymentId },
    });
    expect(row).toMatchObject({ status: 'PAID', late: true, duplicate: true });
    expect(await t.eventTypes(a1.paymentId)).toEqual([
      'payment.failed',
      'payment.duplicate',
    ]);
  });

  it('two attempts paid at the same moment → one succeeded-type, one duplicate', async () => {
    const ref = t.booking();
    const a1 = await t.newPayment(ref);
    await t.mockPay(a1.tradeNO, { status: 'FAILED' }).expect(200);
    const a2 = await t.newPayment(ref);

    await Promise.all([t.mockPay(a1.tradeNO), t.mockPay(a2.tradeNO)]);

    const events = await t.db.outboxEvent.findMany({
      where: { payment: { bookingRef: ref }, type: { not: 'payment.failed' } },
    });
    // Whichever wins the booking lock is the "real" payment; the other is flagged.
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.type === 'payment.duplicate')).toHaveLength(
      1,
    );
  });

  it('the event payload is a complete snapshot (doc §3.2)', async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO).expect(200);
    const [evt] = await t.db.outboxEvent.findMany({
      where: { paymentId: p.paymentId },
    });
    expect(evt.payload).toMatchObject({
      eventId: evt.id,
      type: 'payment.succeeded',
      paymentId: p.paymentId,
      bookingRef: p.bookingRef,
      amount: '1500',
      paidAmount: '1500',
      currency: 'KES',
      providerRef: p.tradeNO,
      late: false,
      duplicate: false,
    });
    expect(evt.deliveredAt).toBeNull(); // Task 5 delivers it
  });
});
