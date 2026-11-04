import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export type KeySource =
  | { kind: 'env'; name: string; pem: string }
  | { kind: 'file'; name: string; path: string };

/**
 * Where a PEM key comes from (doc §5.8). Two options:
 *  - `NAME`       the PEM itself, injected by a secret manager
 *                 (AWS Secrets Manager, GCP Secret Manager, Vault, K8s secrets...).
 *                 "\n" escapes are accepted for one-line env values.
 *  - `NAME_PATH`  a file path (local development, or a secret mounted as a file).
 */
export function keySource(
  env: Record<string, unknown>,
  name: string,
): KeySource | undefined {
  const pem = env[name];
  if (typeof pem === 'string' && pem.trim() !== '') {
    return { kind: 'env', name, pem: pem.replace(/\\n/g, '\n') };
  }
  const path = env[`${name}_PATH`];
  if (typeof path === 'string' && path.trim() !== '') {
    return { kind: 'file', name, path };
  }
  return undefined;
}

/** True when `path` points inside the project folder (e.g. ./keys/private.pem). */
export function isInsideProject(path: string, root = process.cwd()): boolean {
  const rel = relative(root, resolve(root, path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Loads and PARSES the key, so a broken key fails at startup, not on the first
 * payment. Error messages name the variable, never the key content.
 */
export function loadKey(source: KeySource, type: 'private' | 'public'): string {
  const pem =
    source.kind === 'env' ? source.pem : readFileSync(source.path, 'utf8');
  try {
    if (type === 'private') createPrivateKey(pem);
    else createPublicKey(pem);
  } catch {
    const from =
      source.kind === 'env' ? source.name : `${source.name}_PATH file`;
    throw new Error(`${from} does not contain a valid ${type} key (PEM)`);
  }
  return pem;
}
