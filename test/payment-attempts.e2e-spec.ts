import { createTestApp, type TestApp } from './support/test-app.js';

describe('new attempts and refresh-on-read (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp('ATT-');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => t.close());

  /** Pretend time passed: move a payment's timestamps into the past. */
  const age = (id: string, data: { expiresAt?: Date; createdAt?: Date }) =>
    t.db.payment.update({ where: { id }, data });
  const ago = (ms: number) => new Date(Date.now() - ms);

  describe('new attempt while attempt 1 is PENDING', () => {
    it('attempt 1 not expired → 409 PAYMENT_IN_PROGRESS (reuse it)', async () => {
      const ref = t.booking();
      const a1 = await t.newPayment(ref);
      const res = await t.create(t.body(ref), t.key()).expect(409);
      expect(res.body).toMatchObject({
        code: 'PAYMENT_IN_PROGRESS',
        paymentId: a1.paymentId,
      });
    });

    it('attempt 1 expired and unpaid → closed, EXPIRED, attempt 2 created', async () => {
      const ref = t.booking();
      const a1 = await t.newPayment(ref);
      await age(a1.paymentId, { expiresAt: ago(60_000) });
      const close = vi.spyOn(t.provider, 'close');

      const a2 = (await t.create(t.body(ref), t.key()).expect(201)).body;

      expect(a2.attempt).toBe(2);
      expect(close).toHaveBeenCalledWith(a1.paymentId);
      expect(await t.history(a1.paymentId)).toEqual([
        'null→PENDING',
        'PENDING→EXPIRED',
      ]);
      expect(await t.eventTypes(a1.paymentId)).toEqual(['payment.expired']);
    });

    it('attempt 1 expired but Safaricom says PAID → settled, 409 BOOKING_ALREADY_PAID', async () => {
      const ref = t.booking();
      const a1 = await t.newPayment(ref);
      await age(a1.paymentId, { expiresAt: ago(60_000) });
      vi.spyOn(t.provider, 'inquire').mockResolvedValueOnce({
        status: 'PAID',
        providerRef: a1.tradeNO,
        amount: 1500n,
        currency: 'KES',
      });

      const res = await t.create(t.body(ref), t.key()).expect(409);

      expect(res.body.code).toBe('BOOKING_ALREADY_PAID');
      const row = await t.db.payment.findUniqueOrThrow({
        where: { id: a1.paymentId },
      });
      expect(row).toMatchObject({ status: 'PAID', late: true }); // paid after expiresAt
      expect(await t.db.payment.count({ where: { bookingRef: ref } })).toBe(1);
    });

    it('Safaricom unreachable → 502, attempt 1 untouched, nothing created', async () => {
      const ref = t.booking();
      const a1 = await t.newPayment(ref);
      await age(a1.paymentId, { expiresAt: ago(60_000) });
      vi.spyOn(t.provider, 'inquire').mockRejectedValueOnce(
        new Error('timeout'),
      );

      const res = await t.create(t.body(ref), t.key()).expect(502);

      expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
      expect(await t.history(a1.paymentId)).toEqual(['null→PENDING']);
      expect(await t.db.payment.count({ where: { bookingRef: ref } })).toBe(1);
    });
  });

  describe('GET /v1/payments/:id refresh', () => {
    const get = (id: string) => t.signed('GET', `/v1/payments/${id}`);

    it('a fresh PENDING payment is served from the DB (no inquiry)', async () => {
      const p = await t.newPayment();
      const inquire = vi.spyOn(t.provider, 'inquire');
      await get(p.paymentId).expect(200);
      expect(inquire).not.toHaveBeenCalled();
    });

    it('an older PENDING payment asks Safaricom once, and settles if paid', async () => {
      const p = await t.newPayment();
      await age(p.paymentId, { createdAt: ago(20_000) });
      const inquire = vi.spyOn(t.provider, 'inquire').mockResolvedValue({
        status: 'PAID',
        providerRef: p.tradeNO,
        amount: 1500n,
        currency: 'KES',
      });

      const [r1, r2, r3] = await Promise.all([
        get(p.paymentId),
        get(p.paymentId),
        get(p.paymentId),
      ]);

      expect(inquire).toHaveBeenCalledTimes(1); // claimInquiry let only one through
      expect([r1, r2, r3].some((r) => r.body.status === 'PAID')).toBe(true);
      expect(await t.eventTypes(p.paymentId)).toEqual(['payment.succeeded']);
    });

    it('Safaricom down → still 200 with the stored state', async () => {
      const p = await t.newPayment();
      await age(p.paymentId, { createdAt: ago(20_000) });
      vi.spyOn(t.provider, 'inquire').mockRejectedValueOnce(
        new Error('timeout'),
      );

      const res = await get(p.paymentId).expect(200);
      expect(res.body.status).toBe('PENDING');
    });
  });
});
