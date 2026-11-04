// Plays the main backend: prints curl -H flags for a signed request.
// Usage: node --env-file=.env scripts/sign.mjs POST /v1/payments '{"a":1}'
// The body you pass must be byte-identical to the one curl sends.
// See docs/service-auth.md.
import { createHash, createHmac, randomBytes } from 'node:crypto';

const [method, path, body = ''] = process.argv.slice(2);
if (!method || !path) {
  console.error('usage: node --env-file=.env scripts/sign.mjs METHOD PATH [BODY]');
  process.exit(1);
}
const [clientId, secret] = Object.entries(JSON.parse(process.env.SERVICE_HMAC_KEYS))[0];
const ts = Math.floor(Date.now() / 1000).toString();
const nonce = randomBytes(18).toString('base64url');
const canonical = [method.toUpperCase(), path, ts, nonce,
  createHash('sha256').update(body).digest('hex')].join('\n');
const sig = createHmac('sha256', secret).update(canonical).digest('base64url');

console.log(`-H 'X-Client-Id: ${clientId}' -H 'X-Timestamp: ${ts}' -H 'X-Nonce: ${nonce}' -H 'X-Signature: ${sig}'`);
