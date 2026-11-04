import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments/payment.controller.js';
import { MockController } from './payments/mock.controller.js';
import { PAYMENT_PROVIDER } from './providers/payment.provider.interface.js';
import { MpesaMiniAppProvider } from './providers/mpesa-miniapp.provider.js';
import { MockProvider } from './providers/mock.provider.js';
import { PrismaService } from './prisma/prisma.service.js';
import { validateEnv } from './config/env.validation.js';
import { ThrottlerModule } from '@nestjs/throttler';
import { NonceStore } from './auth/nonce.store.js';
import { APP_GUARD } from '@nestjs/core';
import { ClientThrottlerGuard } from './auth/client-throttler.guard.js';
import { ServiceAuthGuard } from './auth/service-auth.guard.js';
import { PaymentsStore } from './payments/payments.store.js';
import { PaymentsService } from './payments/payments.service.js';
import { SettlementService } from './payments/settlement.service.js';
import { NotificationInbox } from './payments/notification-inbox.store.js';
import { NotificationsService } from './payments/notifications.service.js';
import { OutboxDispatcher } from './outbox/outbox.dispatcher.js';
import { ReconcilerService } from './reconciler/reconciler.service.js';
import { JobsScheduler } from './jobs/jobs.scheduler.js';
import { AlertService } from './observability/alert.service.js';
import { HealthController } from './health/health.controller.js';

const isProd = process.env.NODE_ENV === 'production';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
  ],
  // MockController guards itself: it returns 404 unless the mock provider is active.
  controllers: [
    PaymentsController,
    HealthController,
    ...(isProd ? [] : [MockController]),
  ],
  providers: [
    PrismaService,
    AlertService,
    NonceStore,
    // Order matters: auth runs first, so the throttler can key on serviceClientId.
    { provide: APP_GUARD, useClass: ServiceAuthGuard },
    { provide: APP_GUARD, useClass: ClientThrottlerGuard },
    PaymentsStore,
    SettlementService,
    NotificationInbox,
    NotificationsService,
    PaymentsService,
    OutboxDispatcher,
    ReconcilerService,
    JobsScheduler,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (conf: ConfigService) => {
        // No default: a missing setting must not silently fall back to fake payments.
        const name = conf.getOrThrow<string>('PAYMENT_PROVIDER');
        switch (name) {
          case 'mpesa-miniapp':
            return new MpesaMiniAppProvider(conf);
          case 'mock':
            if (conf.get('NODE_ENV') === 'production')
              throw new Error(
                'PAYMENT_PROVIDER=mock is not allowed when NODE_ENV=production',
              );
            return new MockProvider();
          default:
            throw new Error(
              `Unknown PAYMENT_PROVIDER "${name}" (expected: mock | mpesa-miniapp)`,
            );
        }
      },
    },
  ],
})
export class AppModule {}
