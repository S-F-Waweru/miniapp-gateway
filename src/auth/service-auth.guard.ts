import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  parseServiceKeys,
  type ServiceKeys,
} from '../config/env.validation.js';
import { canonicalString, hmacEqual, hmacSign } from './hmac.js';
import { NonceStore } from './nonce.store.js';
import { IS_PUBLIC } from './public.decorator.js';

const MAX_SKEW_MS = 5 * 60_000;
// Must be ≥ 2 × MAX_SKEW: a timestamp 5 min in the future stays valid for 10 min.
const NONCE_TTL_MS = 10 * 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export type AuthedRequest = Request & {
  rawBody?: Buffer;
  serviceClientId?: string;
};

@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly log = new Logger(ServiceAuthGuard.name);
  private readonly keys: ServiceKeys;

  constructor(
    private reflector: Reflector,
    private nonces: NonceStore,
    cfg: ConfigService,
  ) {
    this.keys = parseServiceKeys(cfg.getOrThrow<string>('SERVICE_HMAC_KEYS'));
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const reason = await this.check(req);
    if (reason) {
      // Detailed reason goes to the log; the caller only gets a bare 401.
      this.log.warn(`rejected: ${reason} (${req.method} ${req.originalUrl})`);
      throw new UnauthorizedException();
    }
    return true;
  }

  /** Returns null if valid, otherwise the reason. Cheapchecks first, DB write last. */
  private async check(req: AuthedRequest): Promise<string | null> {
    const clientId = header(req, 'x-client-id');
    const timestamp = header(req, 'x-timestamp');
    const nonce = header(req, 'x-nonce');
    const signature = header(req, 'x-signature');
    if (!clientId || !timestamp || !nonce || !signature)
      return 'missing header';

    // hasOwn: a client id like "constructor" must not resolve to Object.prototype.
    const secret = Object.hasOwn(this.keys, clientId)
      ? this.keys[clientId]
      : undefined;
    if (!secret) return 'unknown client';

    if (!/^\d{10}$/.test(timestamp)) return 'bad timestampformat';
    if (Math.abs(Date.now() - Number(timestamp) * 1000) > MAX_SKEW_MS) {
      return 'timestamp outside window';
    }
    if (!NONCE_RE.test(nonce)) return 'bad nonce format';

    const expected = hmacSign(
      secret,
      canonicalString({
        method: req.method,
        path: req.originalUrl,
        timestamp,
        nonce,
        body: req.rawBody ?? Buffer.alloc(0),
      }),
    );
    if (!hmacEqual(expected, signature)) return 'badsignature';

    // Only after the signature is valid, so attackers can't fill the table
    // or burn nonces the real client is about to use.
    if (!(await this.nonces.claim(`${clientId}:${nonce}`, NONCE_TTL_MS))) {
      return 'replayed nonce';
    }

    req.serviceClientId = clientId; // used by the throttler and later for logging
    return null;
  }
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}
