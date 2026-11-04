export type ServiceKeys = Record<string, string>


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
      throw new Error(`secret for "${id}" must be a string of at least 32 bytes`);
    }
  }
  return  parsed as ServiceKeys;
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
  if (keys) {
    try {
      parseServiceKeys(keys);
    } catch (e) {
      errors.push(`SERVICE_HMAC_KEYS ${(e as Error).message}`);
    }
  }

  if (errors.length) {
    throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }
  return env;
}