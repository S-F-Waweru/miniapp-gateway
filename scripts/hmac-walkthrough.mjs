// HMAC-SHA256 built by hand, printing every intermediate value.
// Run: node scripts/hmac-walkthrough.mjs
// Uses the demo secret from docs/service-auth.md. Never use it for real.
import { createHash, createHmac } from 'node:crypto';

const BLOCK = 64; // SHA-256 processes input in 64-byte blocks
const hex = (b) => Buffer.from(b).toString('hex');
const step = (n, title) => console.log(`\n── Step ${n}: ${title} ${'─'.repeat(50 - title.length)}`);

const secret = Buffer.from('example-secret-do-not-use-in-real-life-0123');
const message = Buffer.from(
  'POST\n/v1/payments\n1793786400\nq3Zr8XkL2mN9pT4vW7yB1c\n' +
    'e1c8b59dbfaf4d279c97595c3eba7a8f75b14e7f1c6102cc1bf9f6bafb74d25e',
);

step(0, 'inputs');
console.log(`secret  (${secret.length} bytes): ${hex(secret)}`);
console.log(`message (${message.length} bytes): ${JSON.stringify(message.toString())}`);

step(1, 'make the key exactly 64 bytes');
// Longer than a block → hash it down to 32 bytes first. Then pad with zeros.
const shortKey = secret.length > BLOCK ? createHash('sha256').update(secret).digest() : secret;
const key = Buffer.alloc(BLOCK);
shortKey.copy(key);
console.log(`key: ${hex(key)}`);
console.log(`     ${shortKey.length} bytes of secret + ${BLOCK - shortKey.length} zero bytes`);

step(2, 'derive two different keys with XOR');
const ipad = Buffer.from(key.map((b) => b ^ 0x36)); // inner key
const opad = Buffer.from(key.map((b) => b ^ 0x5c)); // outer key
console.log(`inner key (key XOR 0x36): ${hex(ipad)}`);
console.log(`outer key (key XOR 0x5c): ${hex(opad)}`);
console.log(`e.g. first byte 'e' = 0x${key[0].toString(16)} → inner 0x${ipad[0].toString(16)}, outer 0x${opad[0].toString(16)}`);
console.log(`     zero padding 0x00 → inner 0x36, outer 0x5c`);

step(3, 'inner hash = SHA256(inner key + message)');
const innerInput = Buffer.concat([ipad, message]);
const inner = createHash('sha256').update(innerInput).digest();
console.log(`input:  ${BLOCK} + ${message.length} = ${innerInput.length} bytes`);
console.log(`output: ${hex(inner)}  (32 bytes)`);

step(4, 'outer hash = SHA256(outer key + inner hash)');
const outerInput = Buffer.concat([opad, inner]);
const outer = createHash('sha256').update(outerInput).digest();
console.log(`input:  ${BLOCK} + 32 = ${outerInput.length} bytes`);
console.log(`output: ${hex(outer)}  (32 bytes)`);

step(5, 'encode for the X-Signature header');
console.log(`base64url: ${outer.toString('base64url')}`);

step(6, 'check against Node’s built-in HMAC');
const builtIn = createHmac('sha256', secret).update(message).digest('base64url');
console.log(`createHmac: ${builtIn}`);
console.log(builtIn === outer.toString('base64url') ? '✅ identical' : '❌ different');

step(7, 'avalanche: change ONE character of the message');
const tampered = Buffer.from(message.toString().replace('1793786400', '1793786401'));
const t = createHmac('sha256', secret).update(tampered).digest();
const diffBits = [...outer].reduce((n, b, i) => n + [...(b ^ t[i]).toString(2)].filter((x) => x === '1').length, 0);
console.log(`original: ${hex(outer)}`);
console.log(`tampered: ${hex(t)}`);
console.log(`${diffBits} of 256 bits differ (~half: no visible link between the two)`);
