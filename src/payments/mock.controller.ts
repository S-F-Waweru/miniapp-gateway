import {
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../providers/payment.provider.interface.js';
import { NotificationsService } from './notifications.service.js';

/** Dev/test only (not registered in production). Simulates Safaricom notifications. */
@Public()
@Controller('mock')
export class MockController {
  constructor(
    private notifications: NotificationsService,
    @Inject(PAYMENT_PROVIDER) private provider: PaymentProvider,
  ) {}

  // Body: { status?: PAID | FAILED | PENDING, amount?: "1500", currency? }
  @Post('pay/:tradeNO')
  @HttpCode(200)
  pay(
    @Param('tradeNO') tradeNO: string,
    @Body() body: { status?: string; amount?: string; currency?: string },
  ) {
    // Decided from the provider actually in use, so it can't drift from config.
    if (this.provider.name !== 'mock') throw new NotFoundException();
    // Same call → same bytes (fixed key order, undefined dropped): needed for inbox dedupe.
    const raw = JSON.stringify({
      tradeNO,
      status: body.status ?? 'PAID',
      amount: body.amount,
      currency: body.currency,
    });
    return this.notifications.handle({}, raw, '/payments/notify');
  }
}
