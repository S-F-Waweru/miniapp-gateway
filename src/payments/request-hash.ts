import { sha256Hex } from '../auth/hmac.js';
import type { CreatePaymentDto } from './dto/create-payment.dto.js';

/**
 * Fingerprint of what the caller asked for. An array fixes the order, and dates are
 * normalised, so the same request always hashes the same however it was serialised.
 */
export function requestHash(i: CreatePaymentDto): string {
  return sha256Hex(
    JSON.stringify([
      i.bookingRef,
      i.amount,
      i.currency,
      i.title,
      i.customerRef ?? null,
      new Date(i.expiresAt).toISOString(),
    ]),
  );
}
