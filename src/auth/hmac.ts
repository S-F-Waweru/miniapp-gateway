import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');

/**
 * METHOD \n PATH \n TIMESTAMP \n NONCE \n sha256(body)
 * PATH includes the query string, so ?bookingRef=... can't be swapped.
 */

export function canonicalString(p: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: Buffer | string;
}): string {
  return [
    p.method.toUpperCase(),
    p.path,
    p.timestamp,
    p.nonce,
    sha256Hex(p.body),
  ].join('\n');
}

export const hmacSign = (secret: string, canonical: string) =>
  createHmac('sha256', secret).update(canonical).digest('base64url');

/** Constant-time comparison. */
export function hmacEqual(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  // timingSafeEqual throws on different lengths. The length isn't secret (always 43 chars).
  return a.length === b.length && timingSafeEqual(a, b);
}
