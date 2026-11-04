import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { keySource, loadKey } from '../config/keys.js';
import {
  isFresh,
  signRequest,
  verifySignature,
} from '../common/signature.utils.js';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  ParsedNotification,
  PaymentProvider,
  PayStatus,
  ProviderOutcome,
} from './payment.provider.interface.js';

@Injectable()
export class MpesaMiniAppProvider implements PaymentProvider {
  name = 'mpesa-miniapp';
  private readonly priv: string;
  private readonly pub: string;

  constructor(private readonly cfg: ConfigService) {
    // Keys come from a secret manager (env) or a file; both are parsed now,
    // so a missing or broken key stops startup instead of the first payment.
    const env = Object.fromEntries(
      [
        'MP_PRIVATE_KEY',
        'MP_PRIVATE_KEY_PATH',
        'MP_PLATFORM_PUBLIC_KEY',
        'MP_PLATFORM_PUBLIC_KEY_PATH',
      ].map((k) => [k, cfg.get<string>(k)]),
    );
    const priv = keySource(env, 'MP_PRIVATE_KEY');
    const pub = keySource(env, 'MP_PLATFORM_PUBLIC_KEY');
    if (!priv || !pub) {
      throw new Error('M-Pesa keys missing (validated in env.validation.ts)');
    }
    this.priv = loadKey(priv, 'private');
    this.pub = loadKey(pub, 'public');
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
        timeout: 10_000, // never hang a request thread on Safaricom
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
      paymentRequestId: i.paymentId, // our ID: lets us retry/inquire after a timeout
      paymentOrderTitle: i.title,
      paymentAmount: {
        currency: i.currency,
        value: toProviderAmount(i.amount),
      },
      paymentExpiryTime: i.expiresAt.toISOString(), // CONFIRM field name + format
      paymentNotifyUrl: `${this.cfg.getOrThrow<string>('PUBLIC_BASE_URL')}/payments/notify`,
    });
    return {
      tradeNO: d.paymentId, // CONFIRM which field = tradeNO
      paymentUrl: d.redirectActionForm?.redirectUrl,
      providerRef: d.paymentId,
    };
  }
  async inquire(paymentId: string): Promise<ProviderOutcome> {
    const d = await this.call('/v1/payments/inquiryPayment', {
      // CONFIRM
      partnerId: this.cfg.getOrThrow<string>('MP_MERCHANT_ID'),
      paymentRequestId: paymentId,
    });
    return toOutcome(d);
  }

  verifyNotification(
    h: Record<string, string>,
    raw: string,
    path: string,
  ): boolean {
    return (
      verifySignature(
        'POST',
        path,
        h['client-id'],
        h['request-time'],
        raw,
        h['signature'],
        this.pub,
      ) && isFresh(h['request-time'])
    );
  }

  parseNotification(raw: string): ParsedNotification {
    const b = JSON.parse(raw);
    if (typeof b?.paymentRequestId !== 'string') {
      throw new Error('missing paymentRequestId');
    }
    return { paymentId: b.paymentRequestId, outcome: toOutcome(b) };
  }

  notifyAck() {
    // CONFIRM the exact acknowledgement body
    return {
      result: {
        resultCode: 'SUCCESS',
        resultStatus: 'S',
        resultMessage: 'success',
      },
    };
  }
}

// Amounts are whole shillings everywhere ("1500" = KES 1,500), the same unit the
// main backend sends and Safaricom uses, so nothing is converted.
// These two functions stay the ONLY place to change if Safaricom's format differs.
function toProviderAmount(amount: bigint): string {
  return amount.toString();
}

// CONFIRM the full list of paymentStatus values with Safaricom.
// Only EXPLICIT terminal values map to PAID/FAILED. Anything else
// (PROCESSING, unknown, missing) means "no change", never FAILED.
const STATUS_MAP: Record<string, PayStatus> = {
  SUCCESS: 'PAID',
  FAIL: 'FAILED',
};

function mapStatus(s: unknown): PayStatus {
  return typeof s === 'string' && Object.hasOwn(STATUS_MAP, s)
    ? STATUS_MAP[s]
    : 'PENDING';
}

// Inverse of toProviderAmount: whole shillings as a digit string. Returns
// undefined if unusable, which the settlement rules treat as an amount
// mismatch (never assume). CONFIRM: if Safaricom ever sends "1500.00",
// accept a ".00" suffix here, in this one place.
function fromProviderAmount(v: unknown): bigint | undefined {
  if (typeof v !== 'string' || !/^\d{1,12}$/.test(v)) return undefined;
  return BigInt(v);
}

function toOutcome(d: any): ProviderOutcome {
  return {
    status: mapStatus(d?.paymentStatus),
    providerRef: typeof d?.paymentId === 'string' ? d.paymentId : undefined,
    amount: fromProviderAmount(d?.paymentAmount?.value),
    currency:
      typeof d?.paymentAmount?.currency === 'string'
        ? d.paymentAmount.currency
        : undefined,
  };
}
