import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../src/providers/payment.provider.interface.js';
import { canonicalString, hmacSign } from '../src/auth/hmac.js';
import { parseServiceKeys } from '../src/config/env.validation.js';

describe('/v1/payments (e2e)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let provider: PaymentProvider;
  let clientId: string;
  let secret: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication<NestExpressApplication>({ rawBody: true });
    configureApp(app);
    await app.init();
    db = app.get(PrismaService);
    provider = app.get(PAYMENT_PROVIDER);
    expect(provider.name).toBe('mock'); // never run these against real Safaricom
    const keys = parseServiceKeys(
      app.get(ConfigService).getOrThrow('SERVICE_HMAC_KEYS'),
    );
    [clientId, secret] = Object.entries(keys)[0];
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    const mine = { bookingRef: { startsWith: 'E2E-' } };
    await db.paymentTransition.deleteMany({ where: { payment: mine } });
    await db.payment.deleteMany({ where: mine });
    await app.close();
  });

  // ---- helpers ------------------------------------------------------------

  const booking = () => `E2E-${randomBytes(4).toString('hex')}`;
  const key = () => `k_${randomBytes(8).toString('hex')}`;
  // Build the body ONCE per test: a new expiresAt = a different request hash.
  const body = (bookingRef: string, over: object = {}) => ({
    bookingRef,
    amount: '1500',
    currency: 'KES',
    title: 'Nairobi → Mombasa',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  });

  function signed(method: 'GET' | 'POST', path: string, payload = '') {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(18).toString('base64url');
    const sig = hmacSign(
      secret,
      canonicalString({ method, path, timestamp: ts, nonce, body: payload }),
    );
    const r = request(app.getHttpServer())[method === 'GET' ? 'get' : 'post'](
      path,
    );
    return r.set({
      'X-Client-Id': clientId,
      'X-Timestamp': ts,
      'X-Nonce': nonce,
      'X-Signature': sig,
    });
  }

  const create = (b: object, k?: string) => {
    const raw = JSON.stringify(b);
    const r = signed('POST', '/v1/payments', raw).set(
      'Content-Type',
      'application/json',
    );
    if (k) r.set('Idempotency-Key', k);
    return r.send(raw);
  };

  // ---- tests --------------------------------------------------------------

  it('creates once; the same key + body replays with 200 and no second provider call', async () => {
    const spy = vi.spyOn(provider, 'createPayment');
    const b = body(booking());
    const k = key();

    const first = await create(b, k).expect(201);
    const again = await create(b, k).expect(200);

    expect(again.body.paymentId).toBe(first.body.paymentId);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(first.body.amount).toBe('1500');
    expect(first.body).not.toHaveProperty('requestHash');
    expect(first.body).not.toHaveProperty('idempotencyKey');
  });

  it('same key with a different body → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const b = body(booking());
    const k = key();
    await create(b, k).expect(201);
    const res = await create({ ...b, amount: '1' }, k).expect(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('two parallel creates for one booking → one payment, one provider call, one 409', async () => {
    const spy = vi.spyOn(provider, 'createPayment');
    const ref = booking();
    const b = body(ref);

    const results = await Promise.all([create(b, key()), create(b, key())]);

    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe(
      'PAYMENT_IN_PROGRESS',
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await db.payment.count({ where: { bookingRef: ref } })).toBe(1);
  });

  it('a paid booking refuses new attempts', async () => {
    const ref = booking();
    const first = await create(body(ref), key()).expect(201);
    await db.payment.update({
      where: { id: first.body.paymentId },
      data: { status: 'PAID', paidAt: new Date() },
    });

    const res = await create(body(ref), key()).expect(409);
    expect(res.body.code).toBe('BOOKING_ALREADY_PAID');
  });

  it('after a FAILED attempt, a new key creates attempt 2', async () => {
    const ref = booking();
    const first = await create(body(ref), key()).expect(201);
    await db.payment.update({
      where: { id: first.body.paymentId },
      data: { status: 'FAILED' },
    });

    const second = await create(body(ref), key()).expect(201);
    expect(second.body.attempt).toBe(2);
  });

  it('validation: missing key → 400, bad amount → 422, expiresAt too far → 422', async () => {
    await create(body(booking())).expect(400);
    await create(body(booking(), { amount: '0' }), key()).expect(422);
    await create(body(booking(), { amount: 1500 }), key()).expect(422); // number, not string
    await create(body(booking(), { amount: '1500.50' }), key()).expect(422); // no cents
    await create(body(booking(), { amount: '01500' }), key()).expect(422); // one spelling only
    const far = new Date(Date.now() + 24 * 3600_000).toISOString();
    const res = await create(body(booking(), { expiresAt: far }), key()).expect(
      422,
    );
    expect(res.body.code).toBe('EXPIRES_AT_TOO_FAR');
  });

  it('unsigned requests → 401', async () => {
    await request(app.getHttpServer())
      .post('/v1/payments')
      .send(body(booking()))
      .expect(401);
  });

  it('provider failure → 502, payment stays PENDING without tradeNO', async () => {
    vi.spyOn(provider, 'createPayment').mockRejectedValueOnce(
      new Error('timeout'),
    );
    const ref = booking();
    const res = await create(body(ref), key()).expect(502);
    expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
    const row = await db.payment.findUniqueOrThrow({
      where: { id: res.body.paymentId },
    });
    expect(row.status).toBe('PENDING');
    expect(row.tradeNO).toBeNull();
  });

  it('GET by id and by bookingRef', async () => {
    const ref = booking();
    const created = await create(body(ref), key()).expect(201);
    const one = await signed(
      'GET',
      `/v1/payments/${created.body.paymentId}`,
    ).expect(200);
    expect(one.body.paymentId).toBe(created.body.paymentId);
    const list = await signed('GET', `/v1/payments?bookingRef=${ref}`).expect(
      200,
    );
    expect(list.body).toHaveLength(1);
  });
});
