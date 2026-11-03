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
