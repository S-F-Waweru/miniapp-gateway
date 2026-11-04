import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import { ServiceAuthGuard } from './service-auth.guard.js';
import type { NonceStore } from './nonce.store.js';
import { canonicalString, hmacSign } from './hmac.js';

const SECRET = 's'.repeat(32);
const BODY = Buffer.from('{"amountMinor":150000}');

function setup(opts: { isPublic?: boolean; claim?: boolean } = {}) {
  const claim = vi.fn().mockResolvedValue(opts.claim ?? true);
  const guard = new ServiceAuthGuard(
    { getAllAndOverride: () => opts.isPublic ?? false } as unknown as Reflector,
    { claim } as unknown as NonceStore,
    { getOrThrow: () => JSON.stringify({ backend: SECRET }) } as unknown as ConfigService,
);
  return { guard, claim };
}

function signedReq(over: { ts?: number; body?: Buffer; sigBody?: Buffer } = {}){
  const timestamp = String(over.ts ?? Math.floor(Date.now() / 1000));
  const nonce = 'n'.repeat(24);
  const signature = hmacSign(
    SECRET,
    canonicalString({ method: 'POST', path: '/v1/payments', timestamp, nonce,body: over.sigBody ?? BODY }),
  );
  return {
    method: 'POST',
    originalUrl: '/v1/payments',
    rawBody: over.body ?? BODY,
    headers: { 'x-client-id': 'backend', 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature },
  } as any;
}

const ctx = (req: any) =>
  ({
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('ServiceAuthGuard', () => {
  it('accepts a correctly signed request and records the client', async () => {
    const { guard, claim } = setup();
    const req = signedReq();
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(claim).toHaveBeenCalledWith('backend:' + 'n'.repeat(24),expect.any(Number));
    expect(req.serviceClientId).toBe('backend');
  });

  it('lets @Public() routes through without headers', async () => {
    const { guard } = setup({ isPublic: true });
    await expect(guard.canActivate(ctx({ headers: {} }))).resolves.toBe(true);
  });

  it('rejects a tampered body and never touches the nonce table', async () => {
    const { guard, claim } = setup();
    const req = signedReq({ body: Buffer.from('{"amountMinor":1}') });
    await expect(guard.canActivate(ctx(req))).rejects.toThrow(UnauthorizedException);
    expect(claim).not.toHaveBeenCalled();
  });

  it('rejects a timestamp older than 5 minutes', async () => {
    const { guard } = setup();
    const req = signedReq({ ts: Math.floor(Date.now() / 1000) - 6 * 60 });
    await expect(guard.canActivate(ctx(req))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a replayed nonce', async () => {
    const { guard } = setup({ claim: false });
    await expect(guard.canActivate(ctx(signedReq()))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an unknown or prototype client id', async () => {
    const { guard } = setup();
    for (const id of ['other', 'constructor', '__proto__']) {
      const req = signedReq();
      req.headers['x-client-id'] = id;
      await expect(guard.canActivate(ctx(req))).rejects.toThrow(UnauthorizedException);
    }
  });

  it('rejects missing headers', async () => {
    const { guard } = setup();
    await expect(guard.canActivate(ctx({ headers: {} }))).rejects.toThrow(UnauthorizedException);
  });
});