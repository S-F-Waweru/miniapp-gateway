import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * For the load balancer / orchestrator: is this instance able to serve?
 * Public (probes can't sign requests) and unthrottled (probes are frequent).
 * Says nothing about payments or configuration, on purpose.
 */
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private db: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.db.$queryRaw`SELECT 1`;
    } catch {
      // 503 → the load balancer stops sending traffic here until the DB is back.
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
    return { status: 'ok' };
  }
}
