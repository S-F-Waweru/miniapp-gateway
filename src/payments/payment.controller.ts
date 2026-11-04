import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { PaymentsService } from './payament.service.js';
import { Public } from '../auth/public.decorator.js';
import { Throttle } from '@nestjs/throttler';

class CreateOrderDto {
  @IsNumber() @Min(1) amount: number;
  @IsString() title: string;
  @IsOptional() @IsString() userId?: string;
}

@Controller()
export class PaymentsController {
  constructor(private svc: PaymentsService) {}

  @Post('orders')
  create(@Body() dto: CreateOrderDto) {
    return this.svc.createOrder(dto.amount, dto.title, dto.userId);
  }

  @Get('orders/:id')
  get(@Param('id') id: string) {
    return this.svc.status(id);
  }

  @Public() // Safaricom can't sign with our HMAC; it has its own RSA check
  @Throttle({ default: { limit: 300, ttl: 60_000 } }) // keyed by IP here
  @Post('payments/notify')
  @HttpCode(200)
  notify(@Req() req: any) {
    return this.svc.notify(
      req.headers,
      req.rawBody.toString('utf8'),
      '/payments/notify',
    );
  }
}
