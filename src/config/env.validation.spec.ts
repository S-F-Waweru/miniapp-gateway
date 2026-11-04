import { generateKeyPairSync } from 'node:crypto';
import { validateEnv } from './env.validation.js';
import { isInsideProject, keySource, loadKey } from './keys.js';

const SECRET = 's'.repeat(40);
const base = () => ({
  DATABASE_URL: 'postgresql://x@localhost/db',
  PAYMENT_PROVIDER: 'mock',
  SERVICE_HMAC_KEYS: JSON.stringify({ 'main-backend-2026': SECRET }),
  PAYMENT_MAX_TTL_MINUTES: '30',
  MAIN_BACKEND_EVENTS_URL: 'http://localhost:4000/events',
  EVENT_HMAC_KEY: 'e'.repeat(40),
});

const mpesa = (over: Record<string, string> = {}) => ({
  ...base(),
  PAYMENT_PROVIDER: 'mpesa-miniapp',
  MP_BASE_URL: 'https://open.example.com',
  MP_CLIENT_ID: 'c',
  MP_MERCHANT_ID: 'm',
  MP_APP_ID: 'a',
  PUBLIC_BASE_URL: 'https://gw.example.com',
  MP_PRIVATE_KEY: 'pem',
  MP_PLATFORM_PUBLIC_KEY: 'pem',
  ...over,
});

const errorsOf = (env: Record<string, unknown>) => {
  try {
    validateEnv(env);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('validateEnv', () => {
  it('accepts a complete config', () => {
    expect(errorsOf(base())).toBe('');
    expect(errorsOf(mpesa())).toBe('');
  });

  it('reports every problem at once', () => {
    const msg = errorsOf({});
    for (const k of [
      'DATABASE_URL',
      'PAYMENT_PROVIDER',
      'SERVICE_HMAC_KEYS',
      'MAIN_BACKEND_EVENTS_URL',
      'EVENT_HMAC_KEY',
    ]) {
      expect(msg).toContain(k);
    }
  });

  it('refuses an event key that equals an inbound key (one key per direction)', () => {
    expect(errorsOf({ ...base(), EVENT_HMAC_KEY: SECRET })).toMatch(
      /must differ/,
    );
  });

  it('requires https for the events URL in production', () => {
    expect(errorsOf({ ...base(), NODE_ENV: 'production' })).toMatch(
      /MAIN_BACKEND_EVENTS_URL must use https/,
    );
  });

  it('M-Pesa: requires every provider setting and both keys', () => {
    const msg = errorsOf({ ...base(), PAYMENT_PROVIDER: 'mpesa-miniapp' });
    expect(msg).toContain('MP_CLIENT_ID is required');
    expect(msg).toContain(
      'MP_PRIVATE_KEY (PEM) or MP_PRIVATE_KEY_PATH is required',
    );
  });

  it('M-Pesa in production: refuses keys stored inside the project folder', () => {
    const env = mpesa({
      NODE_ENV: 'production',
      MAIN_BACKEND_EVENTS_URL: 'https://mb/e',
      MP_PRIVATE_KEY: '',
      MP_PRIVATE_KEY_PATH: 'keys/private.pem',
    });
    expect(errorsOf(env)).toMatch(
      /MP_PRIVATE_KEY_PATH points inside the project folder/,
    );
  });

  it('M-Pesa in production: a mounted secret file outside the project is fine', () => {
    const env = mpesa({
      NODE_ENV: 'production',
      MAIN_BACKEND_EVENTS_URL: 'https://mb/e',
      MP_PRIVATE_KEY: '',
      MP_PRIVATE_KEY_PATH: '/run/secrets/mpesa_private.pem',
    });
    expect(errorsOf(env)).toBe('');
  });

  it('rejects unknown LOG_FORMAT / BACKGROUND_JOBS values', () => {
    expect(errorsOf({ ...base(), LOG_FORMAT: 'xml' })).toMatch(/LOG_FORMAT/);
    expect(errorsOf({ ...base(), BACKGROUND_JOBS: 'yes' })).toMatch(
      /BACKGROUND_JOBS/,
    );
  });
});

describe('keys', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const privPem = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  it('prefers the PEM in env over the file path', () => {
    expect(keySource({ K: privPem, K_PATH: '/x' }, 'K')).toMatchObject({
      kind: 'env',
    });
    expect(keySource({ K_PATH: '/x' }, 'K')).toMatchObject({
      kind: 'file',
      path: '/x',
    });
    expect(keySource({}, 'K')).toBeUndefined();
  });

  it('accepts one-line PEMs with \\n escapes (common in secret managers)', () => {
    const oneLine = privPem.replace(/\n/g, '\\n');
    const src = keySource({ K: oneLine }, 'K')!;
    expect(loadKey(src, 'private')).toBe(privPem);
  });

  it('parses keys at startup, and the error never contains the key', () => {
    expect(loadKey({ kind: 'env', name: 'K', pem: pubPem }, 'public')).toBe(
      pubPem,
    );
    const bad = () =>
      loadKey(
        { kind: 'env', name: 'MP_PRIVATE_KEY', pem: 'SECRET-GARBAGE' },
        'private',
      );
    expect(bad).toThrow(
      'MP_PRIVATE_KEY does not contain a valid private key (PEM)',
    );
    expect(bad).not.toThrow(/SECRET-GARBAGE/);
  });

  it('knows what is inside the project folder', () => {
    expect(isInsideProject('keys/private.pem', '/app')).toBe(true);
    expect(isInsideProject('/app/keys/private.pem', '/app')).toBe(true);
    expect(isInsideProject('/run/secrets/k.pem', '/app')).toBe(false);
    expect(isInsideProject('../elsewhere/k.pem', '/app')).toBe(false);
  });
});
