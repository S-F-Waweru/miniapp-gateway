import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../../src/providers/payment.provider.interface.js';
import { canonicalString, hmacSign } from '../../src/auth/hmac.js';
import { parseServiceKeys } from '../../src/config/env.validation.js';

/**
 * Boots the real app (mock provider) with helpers.
 * `prefix` keeps each spec's bookings separate; each spec cleans up only its
 * own rows. (Spec files run one at a time: see vitest.config.e2e.ts.)
 */
export async function createTestApp(
  prefix: string,
  env: Record<string, string> = {},
) {
  // Config is read when AppModule is first imported, so set the environment
  // first and import it afterwards. Each spec file gets a fresh module graph.
  // Background jobs are off: tests run them by hand, deterministically.
  Object.assign(process.env, { BACKGROUND_JOBS: 'off', ...env });
  const { AppModule } = await import('../../src/app.module.js');

  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = mod.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  configureApp(app);
  await app.init();

  const db = app.get(PrismaService);
  const provider = app.get<PaymentProvider>(PAYMENT_PROVIDER);
  if (provider.name !== 'mock') {
    throw new Error('e2e tests must run with PAYMENT_PROVIDER=mock');
  }
  const keys = parseServiceKeys(
    app.get(ConfigService).getOrThrow('SERVICE_HMAC_KEYS'),
  );
  const [clientId, secret] = Object.entries(keys)[0];
  const http = () => request(app.getHttpServer());

  function signed(method: 'GET' | 'POST', path: string, payload = '') {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(18).toString('base64url');
    const sig = hmacSign(
      secret,
      canonicalString({ method, path, timestamp: ts, nonce, body: payload }),
    );
    return http()[method === 'GET' ? 'get' : 'post'](path).set({
      'X-Client-Id': clientId,
      'X-Timestamp': ts,
      'X-Nonce': nonce,
      'X-Signature': sig,
    });
  }

  const booking = () => `${prefix}${randomBytes(4).toString('hex')}`;
  const key = () => `k_${randomBytes(8).toString('hex')}`;
  const body = (bookingRef: string, over: object = {}) => ({
    bookingRef,
    amount: '1500',
    currency: 'KES',
    title: 'Nairobi → Mombasa',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  });

  const create = (b: object, k?: string) => {
    const raw = JSON.stringify(b);
    const r = signed('POST', '/v1/payments', raw).set(
      'Content-Type',
      'application/json',
    );
    if (k) r.set('Idempotency-Key', k);
    return r.send(raw);
  };

  /** Creates a payment and returns the response body (asserts 201). */
  const newPayment = async (bookingRef = booking()) =>
    (await create(body(bookingRef), key()).expect(201)).body;

  /** Simulated Safaricom notification through /mock/pay. */
  const mockPay = (
    tradeNO: string,
    b: { status?: string; amount?: string; currency?: string } = {},
  ) => http().post(`/mock/pay/${tradeNO}`).send(b);

  /** "null→PENDING", "PENDING→PAID", ... in order. */
  const history = async (paymentId: string) =>
    (
      await db.paymentTransition.findMany({
        where: { paymentId },
        orderBy: { id: 'asc' },
      })
    ).map((x) => `${x.from}→${x.to}`);

  const eventTypes = async (paymentId: string) =>
    (
      await db.outboxEvent.findMany({
        where: { paymentId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.type);

  async function close() {
    const mine = { bookingRef: { startsWith: prefix } };
    const payments = await db.payment.findMany({
      where: mine,
      select: { id: true, providerRef: true },
    });
    // Inbox rows have no FK: find them by payment id, or by tradeNO in the body
    // (forged / failed ones never got a paymentId).
    await db.providerNotification.deleteMany({
      where: {
        OR: [
          { paymentId: { in: payments.map((p) => p.id) } },
          ...payments
            .filter((p) => p.providerRef)
            .map((p) => ({ rawBody: { contains: `"${p.providerRef}"` } })),
        ],
      },
    });
    await db.outboxEvent.deleteMany({ where: { payment: mine } });
    await db.paymentTransition.deleteMany({ where: { payment: mine } });
    await db.payment.deleteMany({ where: mine });
    await app.close();
  }

  return {
    app,
    db,
    provider,
    http,
    signed,
    booking,
    key,
    body,
    create,
    newPayment,
    mockPay,
    history,
    eventTypes,
    close,
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
