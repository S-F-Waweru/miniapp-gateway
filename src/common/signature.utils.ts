import { createSign, createVerify } from 'crypto';

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

export function verifySignature(
  m: string,
  p: string,
  cid: string,
  t: string,
  body: string,
  header: string,
  pubKey: string,
) {
  const sig = decodeURIComponent(
    /signature=([^,]+)/.exec(header ?? '')?.[1] ?? '',
  );
  if (!sig) return false;
  return createVerify('RSA-SHA256')
    .update(content(m, p, cid, t, body))
    .verify(pubKey, sig, 'base64');
}
