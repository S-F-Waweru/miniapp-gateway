import { isInsideProject, keySource } from './keys.js';

export type ServiceKeys = Record<string, string>;

/** Parses SERVICE_HMAC_KEYS ('{"keyId":"secret"}'). Throws on anything malformed. */
export function parseServiceKeys(raw: string): ServiceKeys {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('must be a JSON object like {"keyId":"secret"}');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error('must contain at least one key');
  for (const [id, secret] of entries) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
      throw new Error(
        `secret for "${id}" must be a string of at least 32 bytes`,
      );
    }
  }
  return parsed as ServiceKeys;
}

/** Runs once at startup (ConfigModule). Collects every problem, then fails. */
export function validateEnv(env: Record<string, unknown>) {
  const errors: string[] = [];
  const required = (k: string): string | undefined => {
    const v = env[k];
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`${k} is required`);
      return undefined;
    }
    return v;
  };

  required('DATABASE_URL');
  required('PAYMENT_PROVIDER');

  const keys = required('SERVICE_HMAC_KEYS');
  let serviceSecrets: string[] = [];
  if (keys) {
    try {
      serviceSecrets = Object.values(parseServiceKeys(keys));
    } catch (e) {
      errors.push(`SERVICE_HMAC_KEYS ${(e as Error).message}`);
    }
  }

  // Task 5: events to the main backend
  const eventsUrl = required('MAIN_BACKEND_EVENTS_URL');
  if (eventsUrl) {
    let url: URL | undefined;
    try {
      url = new URL(eventsUrl);
    } catch {
      errors.push('MAIN_BACKEND_EVENTS_URL must be a valid URL');
    }
    if (url && env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      errors.push('MAIN_BACKEND_EVENTS_URL must use https in production');
    }
  }
  const eventKey = required('EVENT_HMAC_KEY');
  if (eventKey && Buffer.byteLength(eventKey) < 32) {
    errors.push('EVENT_HMAC_KEY must be at least 32 bytes');
  }
  // One key per direction: a leaked inbound key must not let anyone forge our events.
  if (eventKey && serviceSecrets.includes(eventKey)) {
    errors.push(
      'EVENT_HMAC_KEY must differ from every SERVICE_HMAC_KEYS secret',
    );
  }

  // Task 7: real provider settings, all checked up front.
  const isProd = env.NODE_ENV === 'production';
  if (env.PAYMENT_PROVIDER === 'mpesa-miniapp') {
    for (const k of [
      'MP_BASE_URL',
      'MP_CLIENT_ID',
      'MP_MERCHANT_ID',
      'MP_APP_ID',
      'PUBLIC_BASE_URL',
    ]) {
      required(k);
    }
    for (const name of ['MP_PRIVATE_KEY', 'MP_PLATFORM_PUBLIC_KEY']) {
      const src = keySource(env, name);
      if (!src) {
        errors.push(`${name} (PEM) or ${name}_PATH is required`);
      } else if (isProd && src.kind === 'file' && isInsideProject(src.path)) {
        // doc §5.8: production keys come from a secret manager, never the repo folder.
        errors.push(
          `${name}_PATH points inside the project folder; in production load keys from a secret manager`,
        );
      }
    }
    if (isProd) {
      for (const k of ['MP_BASE_URL', 'PUBLIC_BASE_URL']) {
        const v = env[k];
        if (typeof v === 'string' && v && !v.startsWith('https://')) {
          errors.push(`${k} must use https in production`);
        }
      }
    }
  }

  const logFormat = env.LOG_FORMAT;
  if (
    logFormat !== undefined &&
    logFormat !== '' &&
    logFormat !== 'json' &&
    logFormat !== 'text'
  ) {
    errors.push('LOG_FORMAT must be "json" or "text"');
  }

  const jobs = env.BACKGROUND_JOBS;
  if (jobs !== undefined && jobs !== '' && jobs !== 'on' && jobs !== 'off') {
    errors.push('BACKGROUND_JOBS must be "on" or "off"');
  }

  const ttl = required('PAYMENT_MAX_TTL_MINUTES');
  if (ttl && !/^[1-9]\d*$/.test(ttl)) {
    errors.push('PAYMENT_MAX_TTL_MINUTES must be a positive integer');
  }

  if (errors.length) {
    throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }
  return env;
}
