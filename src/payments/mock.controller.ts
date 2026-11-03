import { Body, Controller, Param, Post } from '@nestjs/common';
import { PaymentsService } from './payament.service.js';

@Controller('mock')
export class MockController {
  constructor(private svc: PaymentsService) {}

  // status: PAID | FAILED
  @Post('pay/:tradeNO')
  pay(@Param('tradeNO') tradeNO: string, @Body('status') status = 'PAID') {
    return this.svc.notify(
      {},
      JSON.stringify({ tradeNO, status }),
      '/payments/notify',
    );
  }
}
