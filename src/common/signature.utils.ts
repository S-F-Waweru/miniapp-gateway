import { createSign, createVerify } from 'crypto';

/** Max allowed clock difference for a signed message's timestamp (replay protection). */
export const MAX_SKEW_MS = 5 * 60 * 1000;

const content = (m: string, p: string, cid: string, t: string, b: string) =>
  `${m} ${p}\n${cid}.${t}.${b}`;

export function signRequest(
  m: string,
  p: string,
  cid: string,
  t: string,
  body: string,
  privKey: string,
) {
  const sig = createSign('RSA-SHA256')
    .update(content(m, p, cid, t, body))
    .sign(privKey, 'base64');
  return `algorithm=RSA256,keyVersion=1,signature=${encodeURIComponent(sig)}`;
}

/** Returns false (never throws) for missing, malformed or invalid signatures. */
export function verifySignature(
  m: string,
  p: string,
  cid: string | undefined,
  t: string | undefined,
  body: string,
  header: string | undefined,
  pubKey: string,
): boolean {
  if (!cid || !t || !header) return false;
  try {
    const sig = decodeURIComponent(/signature=([^,]+)/.exec(header)?.[1] ?? '');
    if (!sig) return false;
    return createVerify('RSA-SHA256')
      .update(content(m, p, cid, t, body))
      .verify(pubKey, sig, 'base64');
  } catch {
    // Malformed percent-encoding or signature bytes
    return false;
  }
}

/** True when `t` parses as a timestamp within MAX_SKEW_MS of now. */
export function isFresh(t: string | undefined, now = Date.now()): boolean {
  const ts = t ? Date.parse(t) : NaN;
  return !Number.isNaN(ts) && Math.abs(now - ts) <= MAX_SKEW_MS;
}
