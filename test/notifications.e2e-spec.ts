import { SettlementService } from '../src/payments/settlement.service.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('notification inbox (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp('NTF-');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.db.providerNotification.deleteMany({
      where: { rawBody: { contains: '"MOCKdoesnotexist"' } },
    });
    await t.close();
  });

  const inbox = (tradeNO: string) =>
    t.db.providerNotification.findMany({
      where: { rawBody: { contains: tradeNO } },
      orderBy: { id: 'asc' },
    });

  it('stores every notification once, and marks it processed', async () => {
    const p = await t.newPayment();
    await Promise.all(
      Array.from({ length: 5 }, () => t.mockPay(p.tradeNO).expect(200)),
    );

    const rows = await inbox(p.tradeNO);
    expect(rows).toHaveLength(1); // same bytes → same bodyHash → one row
    expect(rows[0].processedAt).not.toBeNull();
    expect(rows[0].paymentId).toBe(p.paymentId);
    expect(rows[0].error).toBeNull();
  });

  it('different notifications for one payment get separate rows', async () => {
    const p = await t.newPayment();
    await t.mockPay(p.tradeNO, { status: 'PENDING' }).expect(200);
    await t.mockPay(p.tradeNO, { status: 'PAID' }).expect(200);
    expect(await inbox(p.tradeNO)).toHaveLength(2);
  });

  it('invalid signature → 401, but the evidence is kept', async () => {
    const p = await t.newPayment();
    vi.spyOn(t.provider, 'verifyNotification').mockReturnValue(false);

    await t.mockPay(p.tradeNO).expect(401);

    const [row] = await inbox(p.tradeNO);
    expect(row.signatureValid).toBe(false);
    expect(row.processedAt).toBeNull();
    expect(await t.history(p.paymentId)).toEqual(['null→PENDING']); // nothing applied
  });

  it('unknown payment → acknowledged (retrying will not help) and recorded', async () => {
    await t.mockPay('MOCKdoesnotexist').expect(200);
    const [row] = await inbox('MOCKdoesnotexist');
    expect(row.processedAt).not.toBeNull();
    expect(row.error).toMatch(/unparseable: unknown trade/);
  });

  it('DB failure → 500 so Safaricom retries; the retry completes the work', async () => {
    const p = await t.newPayment();
    const settlement = t.app.get(SettlementService);
    vi.spyOn(settlement, 'applyOutcome').mockRejectedValueOnce(
      new Error('connection reset'),
    );

    await t.mockPay(p.tradeNO).expect(500);
    let [row] = await inbox(p.tradeNO);
    expect(row.processedAt).toBeNull(); // not done
    expect(row.error).toBe('connection reset');

    await t.mockPay(p.tradeNO).expect(200); // Safaricom's retry, same bytes
    [row] = await inbox(p.tradeNO);
    expect(row.processedAt).not.toBeNull();
    expect(row.error).toBeNull();
    expect(await t.eventTypes(p.paymentId)).toEqual(['payment.succeeded']);
  });
});
