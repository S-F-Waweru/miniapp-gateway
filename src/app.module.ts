import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments/payment.controller.js';
import { MockController } from './payments/mock.controller.js';
import { OrdersStore } from './orders/orders.store.js';
import { PaymentsService } from './payments/payament.service.js';
import { PAYMENT_PROVIDER } from './providers/payment.provider.interface.js';
import { MpesaMiniAppProvider } from './providers/mpesa-miniapp.provider.js';
import { MockProvider } from './providers/mock.provider.js';
import { PrismaService } from './prisma/prisma.service.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  // MockController guards itself: it returns 404 unless the mock provider is active.
  controllers: [PaymentsController, MockController],
  providers: [
    PrismaService,
    OrdersStore,
    PaymentsService,
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
