import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxDispatcher } from '../outbox/outbox.dispatcher.js';
import { ReconcilerService } from '../reconciler/reconciler.service.js';

/**
 * Runs the background jobs on timers. Every instance runs them; each job is
 * safe to run concurrently (see ReconcilerService / OutboxDispatcher).
 *
 * BACKGROUND_JOBS=off disables them (tests drive the jobs by hand).
 */
@Injectable()
export class JobsScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = new Logger(JobsScheduler.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private cfg: ConfigService,
    private outbox: OutboxDispatcher,
    private reconciler: ReconcilerService,
  ) {}

  onApplicationBootstrap() {
    if (this.cfg.get('BACKGROUND_JOBS') === 'off') {
      this.log.warn('background jobs are OFF (BACKGROUND_JOBS=off)');
      return;
    }
    this.every('outbox-dispatch', 2_000, () => this.outbox.dispatchOnce());
    this.every('pending-sweep', 60_000, () => this.reconciler.sweepPending());
    this.every('expiry', 60_000, () => this.reconciler.expireOverdue());
    this.every('health', 5 * 60_000, () => this.reconciler.checkHealth());
    this.every('nonce-cleanup', 5 * 60_000, () =>
      this.reconciler.cleanupNonces(),
    );
    this.log.log('background jobs started');
  }

  /** On SIGTERM: stop the timers, then let any running job finish its work. */
  async onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    await Promise.allSettled(this.running.values());
  }

  /** Run `job` every `ms`, never overlapping itself; errors are logged, never thrown. */
  private every(name: string, ms: number, job: () => Promise<unknown>) {
    const timer = setInterval(() => {
      if (this.running.has(name)) return; // previous run still busy: skip this tick
      const run = job()
        .catch((e: Error) => this.log.error(`${name} failed: ${e.message}`))
        .finally(() => this.running.delete(name));
      this.running.set(name, run);
    }, ms);
    timer.unref(); // timers alone must not keep the process alive
    this.timers.push(timer);
  }
}
