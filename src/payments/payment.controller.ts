import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator.js';
import { CreatePaymentDto } from './dto/create-payment.dto.js';
import { NotificationsService } from './notifications.service.js';
import { PaymentsService } from './payments.service.js';

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{1,128}$/;

@Controller()
export class PaymentsController {
  constructor(
    private svc: PaymentsService,
    private notifications: NotificationsService,
  ) {}

  @Post('v1/payments')
  async create(
    @Body() dto: CreatePaymentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key || !IDEMPOTENCY_KEY_RE.test(key)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    const { created, payment } = await this.svc.create(dto, key);
    res.status(created ? 201 : 200); // 200 = replay, nothing new created
    return payment;
  }

  @Get('v1/payments/:id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Get('v1/payments')
  list(@Query('bookingRef') bookingRef?: string) {
    if (!bookingRef)
      throw new BadRequestException({ code: 'BOOKING_REF_REQUIRED' });
    return this.svc.listByBooking(bookingRef);
  }

  @Public() // Safaricom can't sign with our HMAC; it has its own RSA check
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('payments/notify')
  @HttpCode(200)
  notify(@Req() req: any) {
    return this.notifications.handle(
      req.headers,
      req.rawBody.toString('utf8'),
      '/payments/notify',
    );
  }
}
