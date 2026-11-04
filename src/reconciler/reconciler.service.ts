import { Injectable, Logger } from '@nestjs/common';
import { Alert, AlertService } from '../observability/alert.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentsStore } from '../payments/payments.store.js';
import { SettlementService } from '../payments/settlement.service.js';

/** Give the notification a chance first: only sweep payments older than this. */
const SWEEP_MIN_AGE_MS = 2 * 60_000;
/** After expiresAt, wait this long for a late notification before asking. */
const EXPIRY_GRACE_MS = 2 * 60_000;
/** Payments handled per job run. The next run picks up the rest. */
const BATCH_SIZE = 50;
/** Health thresholds (doc §5.10). */
const OUTBOX_STALLED_MS = 15 * 60_000;
const PENDING_STUCK_MS = 30 * 60_000;

/**
 * How often to ask Safaricom about one PENDING payment, by its age.
 * Most payments settle within minutes; old ones rarely change, so ask less.
 */
export function inquiryIntervalFor(ageMs: number): number {
  if (ageMs < 10 * 60_000) return 60_000; // < 10 min old: every minute
  if (ageMs < 60 * 60_000) return 5 * 60_000; // < 1 h: every 5 min
  return 30 * 60_000; // older: every 30 min
}

export type SweepReport = { checked: number; changed: number; errors: number };
export type ExpiryReport = {
  checked: number;
  expired: number;
  settledOtherwise: number;
  errors: number;
};
export type HealthReport = {
  stalledEvents: number;
  oldestStalledEventAt: Date | null;
  stuckPayments: number;
};

/**
 * Safety net for everything that can go missing (doc §5.4):
 * lost notifications, timed-out pay calls, payments nobody closed.
 *
 * No job-wide lock: every unit of work is already safe to run twice or on two
 * instances at once (claimInquiry = one winner per payment; transition() locks
 * the booking; deletes are idempotent). See docs/task-6-reconciler.md.
 */
@Injectable()
export class ReconcilerService {
  private readonly log = new Logger(ReconcilerService.name);

  constructor(
    private store: PaymentsStore,
    private settlement: SettlementService,
    private db: PrismaService,
    private alerts: AlertService,
  ) {}

  /**
   * Job 1: PENDING payments whose notification hasn't arrived → ask Safaricom.
   * Also covers "pay call timed out, no tradeNO": inquiry is by OUR id.
   */
  async sweepPending(): Promise<SweepReport> {
    const now = Date.now();
    const report: SweepReport = { checked: 0, changed: 0, errors: 0 };
    const candidates = await this.store.findPendingForSweep(
      new Date(now - SWEEP_MIN_AGE_MS),
      BATCH_SIZE,
    );

    for (const p of candidates) {
      const interval = inquiryIntervalFor(now - p.createdAt.getTime());
      if (!(await this.store.claimInquiry(p.id, interval))) continue; // asked recently
      report.checked++;
      try {
        const r = await this.settlement.inquireAndApply(p.id, 'reconciler');
        if (r.changed) report.changed++;
      } catch (e) {
        report.errors++; // one bad payment must not stop the others
        this.log.warn(`sweep ${p.id}: ${(e as Error).message}`);
      }
    }
    return report;
  }

  /** Job 2: PENDING past expiresAt (+grace) → ask, close, expire (only if unpaid). */
  async expireOverdue(): Promise<ExpiryReport> {
    const report: ExpiryReport = {
      checked: 0,
      expired: 0,
      settledOtherwise: 0,
      errors: 0,
    };
    const candidates = await this.store.findOverdue(
      new Date(Date.now() - EXPIRY_GRACE_MS),
      BATCH_SIZE,
    );

    for (const p of candidates) {
      // Short claim: stops two instances (or the sweep) retiring the same payment at once.
      if (!(await this.store.claimInquiry(p.id, 30_000))) continue;
      report.checked++;
      try {
        const final = await this.settlement.retire(p.id, 'reconciler');
        if (final.status === 'EXPIRED') report.expired++;
        else report.settledOtherwise++; // it was actually paid/failed
      } catch (e) {
        report.errors++;
        this.log.warn(`expiry ${p.id}: ${(e as Error).message}`);
      }
    }
    return report;
  }

  /** Job 3: things that should never stay true for long → alert. */
  async checkHealth(): Promise<HealthReport> {
    const now = Date.now();
    const stalledWhere = {
      deliveredAt: null,
      createdAt: { lt: new Date(now - OUTBOX_STALLED_MS) },
    };
    const [stalledEvents, oldest, stuckPayments] = await Promise.all([
      this.db.outboxEvent.count({ where: stalledWhere }),
      this.db.outboxEvent.findFirst({
        where: stalledWhere,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.db.payment.count({
        where: {
          status: 'PENDING',
          createdAt: { lt: new Date(now - PENDING_STUCK_MS) },
        },
      }),
    ]);

    if (stalledEvents > 0) {
      this.alerts.raise(
        Alert.OUTBOX_STALLED,
        'events undelivered for >15 min',
        {
          count: stalledEvents,
          oldestCreatedAt: oldest?.createdAt.toISOString(),
        },
      );
    }
    if (stuckPayments > 0) {
      this.alerts.raise(
        Alert.PAYMENTS_STUCK_PENDING,
        'payments PENDING for >30 min',
        { count: stuckPayments },
      );
    }
    return {
      stalledEvents,
      oldestStalledEventAt: oldest?.createdAt ?? null,
      stuckPayments,
    };
  }

  /** Job 4: replay-protection nonces past their expiry are useless (Task 2). */
  async cleanupNonces(): Promise<number> {
    const { count } = await this.db.requestNonce.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  }
}
