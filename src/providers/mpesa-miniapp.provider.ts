import { ConfigService } from '@nestjs/config';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import axios from 'axios';
import { readFileSync } from 'fs';
import {
  isFresh,
  signRequest,
  verifySignature,
} from '../common/signature.utils.js';
import {
  CreatePaymentInput,
  CreatePaymentResult,
  NotifyResult,
  PaymentProvider,
  PayStatus,
} from './payment.provider.interface.js';

@Injectable()
export class MpesaMiniAppProvider implements PaymentProvider {
  name = 'mpesa-miniapp';
  private readonly priv: string;
  private readonly pub: string;

  constructor(private readonly cfg: ConfigService) {
    // getOrThrow fails fast at startup if a required env var is missing,
    // instead of crashing later with an undefined path or header.
    this.priv = readFileSync(
      cfg.getOrThrow<string>('MP_PRIVATE_KEY_PATH'),
      'utf8',
    );
    this.pub = readFileSync(
      cfg.getOrThrow<string>('MP_PLATFORM_PUBLIC_KEY_PATH'),
      'utf8',
    );
  }

  private async call(path: string, body: unknown): Promise<any> {
    const t = new Date().toISOString();
    const json = JSON.stringify(body);
    const cid = this.cfg.getOrThrow<string>('MP_CLIENT_ID');
    const res = await axios.post<string>(
      this.cfg.getOrThrow<string>('MP_BASE_URL') + path,
      json,
      {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Client-Id': cid,
          'Request-Time': t,
          Signature: signRequest('POST', path, cid, t, json, this.priv),
        },
        // Keep the raw body: the response signature is computed over it.
        responseType: 'text',
        transformResponse: (r: string) => r,
      },
    );
    // CONFIRM: Alipay+ signs responses with Response-Time + Signature headers
    // over "POST <path>\n<clientId>.<responseTime>.<body>".
    const ok = verifySignature(
      'POST',
      path,
      res.headers['client-id'] ?? cid,
      res.headers['response-time'],
      res.data,
      res.headers['signature'],
      this.pub,
    );
    if (!ok) throw new Error(`M-Pesa response signature invalid for ${path}`);
    const data = JSON.parse(res.data);
    if (data.result?.resultStatus === 'F')
      throw new Error(data.result.resultMessage);
    return data;
  }

  async createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult> {
    const d = await this.call('/v1/payments/pay', {
      // CONFIRM path
      partnerId: this.cfg.getOrThrow<string>('MP_MERCHANT_ID'),
      appId: this.cfg.getOrThrow<string>('MP_APP_ID'),
      productCode: 'CASHIER_PAYMENT', // CONFIRM
      paymentRequestId: i.orderId,
      paymentOrderTitle: i.title,
      paymentAmount: { currency: i.currency, value: String(i.amount) }, // CONFIRM units (KES vs cents)
      paymentNotifyUrl: `${this.cfg.getOrThrow<string>('PUBLIC_BASE_URL')}/payments/notify`,
      ...(i.userId && { userId: i.userId }),
    });
    return {
      tradeNO: d.paymentId, // CONFIRM which field = tradeNO
      paymentUrl: d.redirectActionForm?.redirectUrl,
      providerRef: d.paymentId,
    };
  }

  async inquire(orderId: string): Promise<PayStatus> {
    const d = await this.call('/v1/payments/inquiryPayment', {
      // CONFIRM
      partnerId: this.cfg.getOrThrow<string>('MP_MERCHANT_ID'),
      paymentRequestId: orderId,
    });
    return d.paymentStatus === 'SUCCESS'
      ? 'PAID'
      : d.paymentStatus === 'FAIL'
        ? 'FAILED'
        : 'PENDING';
  }

  async handleNotify(
    h: Record<string, string>,
    raw: string,
    path: string,
  ): Promise<NotifyResult> {
    const ok = verifySignature(
      'POST',
      path,
      h['client-id'],
      h['request-time'],
      raw,
      h['signature'],
      this.pub,
    );
    if (!ok) throw new UnauthorizedException('bad signature');
    if (!isFresh(h['request-time']))
      throw new UnauthorizedException('stale or invalid request-time');
    const b = JSON.parse(raw);
    return {
      orderId: b.paymentRequestId,
      providerRef: b.paymentId,
      status: b.paymentStatus === 'SUCCESS' ? 'PAID' : 'FAILED',
      ack: {
        result: {
          resultCode: 'SUCCESS',
          resultStatus: 'S',
          resultMessage: 'success',
        },
      },
    };
  }
}
