import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { sha256Hex } from '../auth/hmac.js';
import { isUniqueViolation } from '../common/prisma-errors.js';

// Only what's useful for investigation. Never cookies or auth headers.
const KEPT_HEADERS = [
  'client-id',
  'request-time',
  'signature',
  'content-type',
  'user-agent',
  'x-forwarded-for',
];

export type InboxEntry = { id: bigint; alreadyProcessed: boolean };

/**
 * Inbox pattern: every Safaricom notification is written down BEFORE we act on it.
 * `bodyHash` is unique, so an exact replay lands on the same row.
 */
@Injectable()
export class NotificationInbox {
  constructor(private db: PrismaService) {}

  async record(n: {
    rawBody: string;
    headers: Record<string, string>;
    signatureValid: boolean;
  }): Promise<InboxEntry> {
    const bodyHash = sha256Hex(n.rawBody);
    try {
      const row = await this.db.providerNotification.create({
        data: {
          bodyHash,
          rawBody: n.rawBody,
          headers: pickHeaders(n.headers),
          signatureValid: n.signatureValid,
        },
      });
      return { id: row.id, alreadyProcessed: false };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Seen these exact bytes before. Processed = just acknowledge.
      // Not processed = the earlier attempt crashed half-way: process again.
      const row = await this.db.providerNotification.findUniqueOrThrow({
        where: { bodyHash },
      });
      return { id: row.id, alreadyProcessed: row.processedAt !== null };
    }
  }

  /** Done: either applied, or permanently unusable (error says why). */
  async markProcessed(
    id: bigint,
    info: { paymentId?: string; providerRef?: string; error?: string },
  ): Promise<void> {
    await this.db.providerNotification.update({
      where: { id },
      data: {
        processedAt: new Date(),
        signatureValid: true, // only verified notifications are ever processed
        paymentId: info.paymentId ?? null,
        providerRef: info.providerRef ?? null,
        error: info.error ?? null,
      },
    });
  }

  /** Temporary failure: processedAt stays null so the retry processes it again. */
  async markError(id: bigint, error: string): Promise<void> {
    await this.db.providerNotification.update({
      where: { id },
      data: { error },
    });
  }
}

function pickHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    KEPT_HEADERS.filter((k) => typeof h[k] === 'string').map((k) => [k, h[k]]),
  );
}
