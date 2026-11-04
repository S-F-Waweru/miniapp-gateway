import {
  Body,
  Controller,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { PaymentsService } from './payament.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../providers/payment.provider.interface.js';

@Controller('mock')
export class MockController {
  constructor(
    private svc: PaymentsService,
    @Inject(PAYMENT_PROVIDER) private provider: PaymentProvider,
  ) {}

  // status: PAID | FAILED
  @Post('pay/:tradeNO')
  pay(@Param('tradeNO') tradeNO: string, @Body('status') status = 'PAID') {
    // Decided from the provider actually in use, so it can't drift from config.
    if (this.provider.name !== 'mock') throw new NotFoundException();
    return this.svc.notify(
      {},
      JSON.stringify({ tradeNO, status }),
      '/payments/notify',
    );
  }
}
