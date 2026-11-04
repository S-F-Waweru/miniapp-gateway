// Usage: node --env-file=.env scripts/sign.mjs POST /v1/payments '{"a":1}'
// Prints curl -H flags. The body you pass must be byte-identical to the one curl sends.
import { createHash, createHmac, randomBytes } from 'node:crypto';

const [method, path, body = ''] = process.argv.slice(2);
const [clientId, secret] = Object.entries(
  JSON.parse(process.env.SERVICE_HMAC_KEYS),
)[0];
const ts = Math.floor(Date.now() / 1000).toString();
const nonce = randomBytes(18).toString('base64url');
const canonical = [
  method.toUpperCase(),
  path,
  ts,
  nonce,
  createHash('sha256').update(body).digest('hex'),
].join('\n');
const sig = createHmac('sha256', secret).update(canonical).digest('base64url');

console.log(
  `-H 'X-Client-Id: ${clientId}' -H 'X-Timestamp: ${ts}' -H 'X-Nonce: ${nonce}' -H 'X-Signature: ${sig}'`,
);
