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

const isMock = (process.env.PAYMENT_PROVIDER ?? 'mock') === 'mock';

@Module({
  imports: [ConfigModule.forRoot({isGlobal: true})],
  controllers: [PaymentsController, ...(isMock ? [MockController] : [])],
  providers: [
    OrdersStore,
    PaymentsService,
    {
      provide :PAYMENT_PROVIDER,
      inject:[ConfigService],
      useFactory: (conf : ConfigService) => {
        switch (conf.get('PAYMENT_PROVIDER')) {
          case 'mpesa-miniapp':
            return new MpesaMiniAppProvider(conf);
          default:
            return new MockProvider();
        }
      }
    }
  ],
})
export class AppModule {}
