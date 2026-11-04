import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalString, hmacEqual, hmacSign } from '../../src/auth/hmac.js';

export type ReceivedEvent = {
  headers: IncomingHttpHeaders;
  body: string;
  event: Record<string, any>;
  signatureValid: boolean;
};

/**
 * A stand-in for the main backend's events endpoint. Records every request,
 * verifies its HMAC signature with `secret`, and can be told to fail.
 */
export async function startFakeBackend(
  secret: string,
  path = '/v1/gateway/events',
) {
  const received: ReceivedEvent[] = [];
  const failures = new Map<string, number>(); // paymentId → failures left

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const h = (name: string) => String(req.headers[name] ?? '');
      const expected = hmacSign(
        secret,
        canonicalString({
          method: req.method ?? '',
          path: req.url ?? '',
          timestamp: h('x-timestamp'),
          nonce: h('x-nonce'),
          body,
        }),
      );
      const event = JSON.parse(body);
      received.push({
        headers: req.headers,
        body,
        event,
        signatureValid: hmacEqual(expected, h('x-signature')),
      });

      const left = failures.get(event.paymentId) ?? 0;
      if (left > 0) failures.set(event.paymentId, left - 1);
      res.statusCode = left > 0 ? 500 : 200;
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}${path}`,
    received,
    /** Answer 500 to the next `times` events of this payment. */
    failFor(paymentId: string, times = 1) {
      failures.set(paymentId, times);
    },
    /** Everything received for one payment, in arrival order. */
    forPayment(paymentId: string) {
      return received.filter((r) => r.event.paymentId === paymentId);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
