import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { canonicalString, hmacSign } from '../auth/hmac.js';
import { Alert, AlertService } from '../observability/alert.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Events sent per pass. Small batches keep one slow backend from hogging a pass. */
const BATCH_SIZE = 20;
/** Never wait longer than this for the main backend. */
const HTTP_TIMEOUT_MS = 10_000;
/** Wait before retry N (1-based). After the list runs out: every 30 min, forever. */
const BACKOFF_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000];
const MAX_BACKOFF_MS = 30 * 60_000;
/** Still undelivered after this long → alert on every failed attempt. */
const ALERT_AFTER_MS = 48 * 60 * 60_000;

export const backoffFor = (attempt: number): number =>
  BACKOFF_MS[attempt - 1] ?? MAX_BACKOFF_MS;

type ClaimedEvent = {
  id: string;
  paymentId: string;
  type: string;
  payload: unknown;
  attempts: number;
  createdAt: Date;
};

export type DispatchResult = { delivered: number; failed: number };

/**
 * Transactional outbox, sending side (doc §5.5).
 * Picks due events, POSTs them to the main backend signed with HMAC, and records
 * the result. Delivery is at-least-once: the receiver dedupes on eventId.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly log = new Logger(OutboxDispatcher.name);
  private readonly url: URL;
  private readonly key: string;
  private readonly clientId: string;

  constructor(
    private db: PrismaService,
    private alerts: AlertService,
    cfg: ConfigService,
  ) {
    this.url = new URL(cfg.getOrThrow<string>('MAIN_BACKEND_EVENTS_URL'));
    this.key = cfg.getOrThrow<string>('EVENT_HMAC_KEY');
    this.clientId = cfg.get<string>('EVENT_CLIENT_ID') || 'miniapp-gateway';
  }

  /** One pass: claim due events, send them one by one, record each result. */
  async dispatchOnce(): Promise<DispatchResult> {
    const events = await this.claim();
    const result: DispatchResult = { delivered: 0, failed: 0 };
    for (const e of events) {
      if (await this.deliver(e)) result.delivered++;
      else result.failed++;
    }
    return result;
  }

  /**
   * Claim = one UPDATE that picks due events and pushes their nextAttemptAt
   * 60 s into the future (a "lease"). While we're sending, nobody else picks
   * them; if we crash, the lease runs out and they become due again.
   *
   * - FOR UPDATE SKIP LOCKED: two gateway instances claiming at the same moment
   *   get different rows instead of waiting or double-sending.
   * - NOT EXISTS (...): per payment, events go out in order. A later event waits
   *   until every earlier event of the same payment is delivered, so the main
   *   backend never sees "late_succeeded" before "failed".
   * - Times use the database clock in UTC, the same way Prisma stores them.
   */
  private async claim(): Promise<ClaimedEvent[]> {
    const rows = await this.db.$queryRaw<ClaimedEvent[]>`
      UPDATE "OutboxEvent"
      SET "nextAttemptAt" = timezone('utc', now()) + interval '60 seconds',
          "attempts" = "attempts" + 1
      WHERE id IN (
        SELECT e.id FROM "OutboxEvent" e
        WHERE e."deliveredAt" IS NULL
          AND e."nextAttemptAt" <= timezone('utc', now())
          AND NOT EXISTS (
            SELECT 1 FROM "OutboxEvent" prev
            WHERE prev."paymentId" = e."paymentId"
              AND prev."deliveredAt" IS NULL
              AND (prev."createdAt", prev.id) < (e."createdAt", e.id)
          )
        ORDER BY e."createdAt", e.id
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "paymentId", type, payload, attempts, "createdAt"`;
    // RETURNING has no guaranteed order.
    return rows.sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  }

  /** Send one event. true = the main backend stored it (2xx). */
  private async deliver(e: ClaimedEvent): Promise<boolean> {
    // We sign exactly the bytes we send (jsonb may have reordered keys; that's fine).
    const body = JSON.stringify(e.payload);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: this.signedHeaders(e.id, body),
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'error', // a redirect could leak the signed request elsewhere
      });
      await res.body?.cancel(); // free the connection; we only need the status
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      await this.db.outboxEvent.update({
        where: { id: e.id },
        data: { deliveredAt: new Date(), lastError: null },
      });
      return true;
    } catch (err) {
      const message = errorMessage(err);
      const delay = backoffFor(e.attempts);
      await this.db.outboxEvent.update({
        where: { id: e.id },
        data: {
          nextAttemptAt: new Date(Date.now() + delay),
          lastError: message.slice(0, 500),
        },
      });
      const age = Date.now() - e.createdAt.getTime();
      const line = `event ${e.id} (${e.type}, ${e.paymentId}) attempt ${e.attempts} failed: ${message}; retry in ${delay / 1000}s`;
      if (age > ALERT_AFTER_MS) {
        this.alerts.raise(Alert.EVENT_DELIVERY_FAILING, line, {
          eventId: e.id,
          paymentId: e.paymentId,
          attempts: e.attempts,
        });
      } else {
        this.log.warn(line);
      }
      return false;
    }
  }

  /** Same scheme as inbound requests (docs/service-auth.md), with our own key. */
  private signedHeaders(eventId: string, body: string): Record<string, string> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(18).toString('base64url');
    const signature = hmacSign(
      this.key,
      canonicalString({
        method: 'POST',
        path: this.url.pathname + this.url.search,
        timestamp,
        nonce,
        body,
      }),
    );
    return {
      'Content-Type': 'application/json',
      'X-Client-Id': this.clientId,
      'X-Gateway-Event-Id': eventId,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': signature,
    };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError')
      return `timeout after ${HTTP_TIMEOUT_MS}ms`;
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return cause ? `${err.message} (${cause})` : err.message;
  }
  return String(err);
}
