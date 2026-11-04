// SHA-256 written from scratch, printing what happens at each stage.
// Run: node scripts/sha256-walkthrough.mjs            (hashes "abc")
//      node scripts/sha256-walkthrough.mjs "any text"
import { createHash } from 'node:crypto';

const input = Buffer.from(process.argv[2] ?? 'abc');
const h32 = (n) => (n >>> 0).toString(16).padStart(8, '0');
const title = (t) => console.log(`\n── ${t} ${'─'.repeat(55 - t.length)}`);

// Fixed public constants from the standard:
// H = first 32 bits of the fractional parts of the square roots of the first 8 primes
// K = first 32 bits of the fractional parts of the cube roots of the first 64 primes
const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// The only operations SHA-256 uses: rotate, shift, XOR, AND, NOT, add (mod 2^32)
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
const add = (...xs) => xs.reduce((a, b) => (a + b) >>> 0, 0);

title('1. input');
console.log(`${input.length} bytes: ${JSON.stringify(input.toString())}`);
console.log(`hex: ${input.toString('hex')}`);

title('2. padding');
// input + one 1-bit (0x80) + zeros + 8-byte length in bits, total a multiple of 64 bytes
const total = Math.ceil((input.length + 1 + 8) / 64) * 64;
const padded = Buffer.alloc(total);
input.copy(padded);
padded[input.length] = 0x80;
padded.writeBigUInt64BE(BigInt(input.length * 8), total - 8);
console.log(`${input.length} bytes + 0x80 + ${total - input.length - 9} zero bytes + 8-byte length (${input.length * 8} bits)`);
console.log(`= ${total} bytes = ${total / 64} block(s) of 64 bytes`);

title('3. starting state (8 numbers)');
const state = [...H];
console.log(state.map(h32).join(' '));

for (let b = 0; b < total / 64; b++) {
  const block = padded.subarray(b * 64, b * 64 + 64);

  title(`4. block ${b + 1}: expand 16 words → 64 words`);
  const W = new Array(64);
  for (let t = 0; t < 16; t++) W[t] = block.readUInt32BE(t * 4);
  for (let t = 16; t < 64; t++) {
    const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
    const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
    W[t] = add(W[t - 16], s0, W[t - 7], s1);
  }
  console.log(`W[0..3]   ${W.slice(0, 4).map(h32).join(' ')}   (straight from the block)`);
  console.log(`W[16..19] ${W.slice(16, 20).map(h32).join(' ')}   (mixed from earlier words)`);

  title(`5. block ${b + 1}: 64 rounds of mixing`);
  let [a, bb, c, d, e, f, g, h] = state;
  for (let t = 0; t < 64; t++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g); // "choose": e picks bits from f or g
    const T1 = add(h, S1, ch, K[t], W[t]);
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & bb) ^ (a & c) ^ (bb & c); // "majority" of a, b, c
    const T2 = add(S0, maj);
    [h, g, f, e, d, c, bb, a] = [g, f, e, add(d, T1), c, bb, a, add(T1, T2)];
    if (t < 3 || t === 63) console.log(`round ${String(t + 1).padStart(2)}: a=${h32(a)} e=${h32(e)}`);
    if (t === 3) console.log('   ...');
  }

  title(`6. block ${b + 1}: add the result to the state`);
  [a, bb, c, d, e, f, g, h].forEach((v, i) => (state[i] = add(state[i], v)));
  console.log(state.map(h32).join(' '));
}

title('7. the hash = the final state');
const mine = state.map(h32).join('');
const builtIn = createHash('sha256').update(input).digest('hex');
console.log(`from scratch: ${mine}`);
console.log(`node crypto:  ${builtIn}`);
console.log(mine === builtIn ? '✅ identical' : '❌ different');
