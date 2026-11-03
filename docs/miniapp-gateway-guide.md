# M-Pesa Mini App Payment Gateway (NestJS mock)

A NestJS gateway that sits between your M-Pesa Mini App and the payment provider:
- Creates orders and returns a `tradeNO` (or `paymentUrl`) for `my.tradePay`
- Receives payment notifications and exposes order status
- Lets you switch providers with one env variable: `mock`, `mpesa-miniapp`, and later `daraja` or others

> **Spec note:** The public M-Pesa Mini App docs only document the client side (`my.tradePay`, `my.getAuthCode`). The server-side calls below follow the **Alipay+ Mini Program OpenAPI standard** that the M-Pesa platform is built on. Lines marked `// CONFIRM` must be checked against the server spec Safaricom gives you.

```
Mini App ──my.request──▶ Gateway /orders ──▶ Provider (mock | M-Pesa | Daraja)
   │                          ▲                         │
   └── my.tradePay(tradeNO)   └──── /payments/notify ◀──┘
```

---

## 1. Scaffold

```bash
npm i -g @nestjs/cli
nest new miniapp-gateway && cd miniapp-gateway
npm i @nestjs/config axios uuid class-validator class-transformer
npm i -D @types/uuid
```

Folder layout:

```
src/
  common/signature.util.ts
  providers/payment-provider.interface.ts
  providers/mock.provider.ts
  providers/mpesa-miniapp.provider.ts
  orders/orders.store.ts
  payments/payments.service.ts
  payments/payments.controller.ts
  payments/mock.controller.ts
  app.module.ts
  main.ts
```

---

## 2. Environment (`.env`)

```env
PORT=3000
PAYMENT_PROVIDER=mock               # mock | mpesa-miniapp
PUBLIC_BASE_URL=https://xxxx.trycloudflare.com

# M-Pesa Mini App (Mini Program Platform → Workspace → App Manage / Key Manage)
MP_BASE_URL=https://<safaricom-openapi-host>   # CONFIRM
MP_CLIENT_ID=
MP_MERCHANT_ID=
MP_APP_ID=
MP_PRIVATE_KEY_PATH=./keys/private.pem
MP_PLATFORM_PUBLIC_KEY_PATH=./keys/safaricom_public.pem
```

Generate your RSA keys, then upload `keys/public.pem` in **Key Manage** and save Safaricom's public key as `keys/safaricom_public.pem`:

```bash
mkdir keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem
```

Add `keys/` and `.env` to `.gitignore`.

---

## 3. Signature util — `src/common/signature.util.ts`

Alipay+ format. The string to sign is `"<METHOD> <PATH>\n<clientId>.<requestTime>.<body>"`.

```ts
import { createSign, createVerify } from 'crypto';

const content = (m: string, p: string, cid: string, t: string, b: string) =>
  `${m} ${p}\n${cid}.${t}.${b}`;

export function signRequest(m: string, p: string, cid: string, t: string, body: string, privKey: string) {
  const sig = createSign('RSA-SHA256').update(content(m, p, cid, t, body)).sign(privKey, 'base64');
  return `algorithm=RSA256,keyVersion=1,signature=${encodeURIComponent(sig)}`;
}

export function verifySignature(m: string, p: string, cid: string, t: string, body: string, header: string, pubKey: string) {
  const sig = decodeURIComponent(/signature=([^,]+)/.exec(header ?? '')?.[1] ?? '');
  if (!sig) return false;
  return createVerify('RSA-SHA256').update(content(m, p, cid, t, body)).verify(pubKey, sig, 'base64');
}
```

---

## 4. Provider contract — `src/providers/payment-provider.interface.ts`

Every gateway implements this interface, so the rest of the app never changes when you switch providers.

```ts
export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export type PayStatus = 'PENDING' | 'PAID' | 'FAILED';

export interface CreatePaymentInput {
  orderId: string; amount: number; currency: string; title: string; userId?: string;
}
export interface CreatePaymentResult {
  tradeNO?: string; paymentUrl?: string; providerRef: string;
}
export interface NotifyResult {
  orderId: string; status: PayStatus; providerRef: string; ack: any; // ack = body returned to provider
}

export interface PaymentProvider {
  name: string;
  createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult>;
  inquire(orderId: string): Promise<PayStatus>;
  handleNotify(headers: Record<string, string>, rawBody: string, path: string): Promise<NotifyResult>;
}
```

---

## 5. Mock provider — `src/providers/mock.provider.ts`

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PaymentProvider, PayStatus } from './payment-provider.interface';

@Injectable()
export class MockProvider implements PaymentProvider {
  name = 'mock';
  private trades = new Map<string, { orderId: string; status: PayStatus }>();

  async createPayment(i) {
    const tradeNO = `MOCK${Date.now()}`;
    this.trades.set(tradeNO, { orderId: i.orderId, status: 'PENDING' });
    return { tradeNO, providerRef: tradeNO };
  }

  async inquire(orderId: string) {
    return [...this.trades.values()].find(t => t.orderId === orderId)?.status ?? 'PENDING';
  }

  async handleNotify(_h, raw: string) {
    const { tradeNO, status } = JSON.parse(raw);
    const t = this.trades.get(tradeNO);
    if (!t) throw new NotFoundException('trade not found');
    t.status = status;
    return { orderId: t.orderId, status, providerRef: tradeNO,
             ack: { result: { resultCode: 'SUCCESS', resultStatus: 'S', resultMessage: 'success' } } };
  }
}
```

---

## 6. M-Pesa Mini App provider — `src/providers/mpesa-miniapp.provider.ts`

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { readFileSync } from 'fs';
import { signRequest, verifySignature } from '../common/signature.util';
import { PaymentProvider, PayStatus } from './payment-provider.interface';

@Injectable()
export class MpesaMiniAppProvider implements PaymentProvider {
  name = 'mpesa-miniapp';
  private priv: string;
  private pub: string;

  constructor(private cfg: ConfigService) {
    this.priv = readFileSync(cfg.get('MP_PRIVATE_KEY_PATH'), 'utf8');
    this.pub = readFileSync(cfg.get('MP_PLATFORM_PUBLIC_KEY_PATH'), 'utf8');
  }

  private async call(path: string, body: any) {
    const t = new Date().toISOString();
    const json = JSON.stringify(body);
    const cid = this.cfg.get('MP_CLIENT_ID');
    const { data } = await axios.post(this.cfg.get('MP_BASE_URL') + path, json, {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Client-Id': cid,
        'Request-Time': t,
        Signature: signRequest('POST', path, cid, t, json, this.priv),
      },
    });
    if (data.result?.resultStatus === 'F') throw new Error(data.result.resultMessage);
    return data;
  }

  async createPayment(i) {
    const d = await this.call('/v1/payments/pay', {             // CONFIRM path
      partnerId: this.cfg.get('MP_MERCHANT_ID'),
      appId: this.cfg.get('MP_APP_ID'),
      productCode: 'CASHIER_PAYMENT',                            // CONFIRM
      paymentRequestId: i.orderId,
      paymentOrderTitle: i.title,
      paymentAmount: { currency: i.currency, value: String(i.amount) }, // CONFIRM units (KES vs cents)
      paymentNotifyUrl: `${this.cfg.get('PUBLIC_BASE_URL')}/payments/notify`,
      ...(i.userId && { userId: i.userId }),
    });
    return {
      tradeNO: d.paymentId,                                      // CONFIRM which field = tradeNO
      paymentUrl: d.redirectActionForm?.redirectUrl,
      providerRef: d.paymentId,
    };
  }

  async inquire(orderId: string): Promise<PayStatus> {
    const d = await this.call('/v1/payments/inquiryPayment', {  // CONFIRM
      partnerId: this.cfg.get('MP_MERCHANT_ID'),
      paymentRequestId: orderId,
    });
    return d.paymentStatus === 'SUCCESS' ? 'PAID' : d.paymentStatus === 'FAIL' ? 'FAILED' : 'PENDING';
  }

  async handleNotify(h, raw: string, path: string) {
    const ok = verifySignature('POST', path, h['client-id'], h['request-time'], raw, h['signature'], this.pub);
    if (!ok) throw new UnauthorizedException('bad signature');
    const b = JSON.parse(raw);
    return {
      orderId: b.paymentRequestId,
      providerRef: b.paymentId,
      status: b.paymentStatus === 'SUCCESS' ? 'PAID' : 'FAILED',
      ack: { result: { resultCode: 'SUCCESS', resultStatus: 'S', resultMessage: 'success' } },
    };
  }
}
```

---

## 7. Orders store — `src/orders/orders.store.ts`

In-memory for the mock. Swap it for TypeORM or Prisma later.

```ts
import { Injectable } from '@nestjs/common';
import { PayStatus } from '../providers/payment-provider.interface';

export type Order = { id: string; amount: number; title: string; status: PayStatus; providerRef?: string };

@Injectable()
export class OrdersStore {
  private m = new Map<string, Order>();
  save(o: Order) { this.m.set(o.id, o); return o; }
  get(id: string) { return this.m.get(id); }
}
```

---

## 8. Service — `src/payments/payments.service.ts`

```ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { OrdersStore } from '../orders/orders.store';
import { PAYMENT_PROVIDER, PaymentProvider } from '../providers/payment-provider.interface';

@Injectable()
export class PaymentsService {
  constructor(@Inject(PAYMENT_PROVIDER) private provider: PaymentProvider, private orders: OrdersStore) {}

  async createOrder(amount: number, title: string, userId?: string) {
    const order = this.orders.save({ id: uuid().replace(/-/g, ''), amount, title, status: 'PENDING' });
    const r = await this.provider.createPayment({ orderId: order.id, amount, currency: 'KES', title, userId });
    order.providerRef = r.providerRef;
    return { orderId: order.id, tradeNO: r.tradeNO, paymentUrl: r.paymentUrl, provider: this.provider.name };
  }

  async status(id: string) {
    const o = this.orders.get(id);
    if (!o) throw new NotFoundException();
    if (o.status === 'PENDING') o.status = await this.provider.inquire(id); // fallback if notify missed
    return o;
  }

  async notify(headers: any, raw: string, path: string) {
    const r = await this.provider.handleNotify(headers, raw, path);
    const o = this.orders.get(r.orderId);
    if (o && o.status === 'PENDING') o.status = r.status;   // idempotent
    return r.ack;
  }
}
```

---

## 9. Controllers

### `src/payments/payments.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { PaymentsService } from './payments.service';

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
    return this.svc.notify(req.headers, req.rawBody.toString('utf8'), '/payments/notify');
  }
}
```

### `src/payments/mock.controller.ts` (simulates the wallet; mock mode only)

```ts
import { Body, Controller, Param, Post } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('mock')
export class MockController {
  constructor(private svc: PaymentsService) {}

  // status: PAID | FAILED
  @Post('pay/:tradeNO')
  pay(@Param('tradeNO') tradeNO: string, @Body('status') status = 'PAID') {
    return this.svc.notify({}, JSON.stringify({ tradeNO, status }), '/payments/notify');
  }
}
```

---

## 10. Wiring — `src/app.module.ts`

The provider is picked at startup from `PAYMENT_PROVIDER`.

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OrdersStore } from './orders/orders.store';
import { PaymentsService } from './payments/payments.service';
import { PaymentsController } from './payments/payments.controller';
import { MockController } from './payments/mock.controller';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
import { MockProvider } from './providers/mock.provider';
import { MpesaMiniAppProvider } from './providers/mpesa-miniapp.provider';

const isMock = (process.env.PAYMENT_PROVIDER ?? 'mock') === 'mock';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [PaymentsController, ...(isMock ? [MockController] : [])],
  providers: [
    OrdersStore,
    PaymentsService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        switch (cfg.get('PAYMENT_PROVIDER')) {
          case 'mpesa-miniapp': return new MpesaMiniAppProvider(cfg);
          // case 'daraja':      return new DarajaStkProvider(cfg);
          default:              return new MockProvider();
        }
      },
    },
  ],
})
export class AppModule {}
```

> `isMock` reads `process.env` directly because controllers are resolved before `ConfigModule` loads. Run with `node -r dotenv/config` or export the variable, or keep `MockController` always on and guard it inside.

---

## 11. Bootstrap — `src/main.ts`

`rawBody` is required for signature verification.

```ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

---

## 12. Run and expose publicly

```bash
npm run start:dev
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```

Put the tunnel URL in `PUBLIC_BASE_URL`.

Then, on the Mini Program Platform, go to **Settings → Domain Preference** and add the gateway domain to the whitelist. `my.request` will be blocked without this.

---

## 13. Test with curl (mock mode)

```bash
# create order
curl -X POST localhost:3000/orders -H 'Content-Type: application/json' \
  -d '{"amount":100,"title":"Test ticket"}'
# → { "orderId":"abc…", "tradeNO":"MOCK1730…", "provider":"mock" }

# simulate wallet payment
curl -X POST localhost:3000/mock/pay/MOCK1730… -H 'Content-Type: application/json' -d '{"status":"PAID"}'

# check status
curl localhost:3000/orders/abc…
# → { "status":"PAID", … }
```

---

## 14. Mini App client

```js
// utils/pay.js
const GATEWAY = 'https://xxxx.trycloudflare.com';
const MOCK = true; // false when using the real provider

const req = (url, method = 'GET', data) => new Promise((resolve, reject) =>
  my.request({ url: GATEWAY + url, method, data, headers: { 'Content-Type': 'application/json' },
               success: r => resolve(r.data), fail: reject }));

export async function pay(amount, title) {
  const { orderId, tradeNO, paymentUrl } = await req('/orders', 'POST', { amount, title });

  if (MOCK) {
    // a fake tradeNO can't open the real cashier — simulate it
    const ok = await new Promise(r => my.confirm({ content: `Pay KES ${amount}?`, success: x => r(x.confirm) }));
    await req(`/mock/pay/${tradeNO}`, 'POST', { status: ok ? 'PAID' : 'FAILED' });
  } else {
    await new Promise((resolve) => my.tradePay({
      ...(tradeNO ? { tradeNO } : { paymentUrl }),
      success: resolve,   // resultCode 9000 = success, 6001 = cancelled, 8000/6004 = check server
      fail: resolve,
    }));
  }

  // always trust the server, not the client resultCode
  return req(`/orders/${orderId}`);
}
```

Usage:

```js
import { pay } from '../../utils/pay';
Page({
  async onPay() {
    const o = await pay(100, 'Bus ticket');
    my.alert({ content: o.status === 'PAID' ? 'Paid ✅' : 'Not paid' });
  },
});
```

---

## 15. Switch to real M-Pesa

1. Get the Client ID, Merchant ID and App ID, and exchange keys in **Workspace → App Manage / Key Manage**.
2. Get the server-side payment spec from Safaricom and fix every `// CONFIRM` line.
3. Set `PAYMENT_PROVIDER=mpesa-miniapp` and fill in the `MP_*` variables.
4. Set `MOCK = false` in the client.
5. Test inside the M-Pesa app using a whitelisted tester (**Settings → Whitelist for Testers**).

---

## 16. Add another gateway (e.g. Daraja STK Push)

1. Create `src/providers/daraja-stk.provider.ts` that implements `PaymentProvider`:
   - `createPayment`: OAuth token, then `POST /mpesa/stkpush/v1/processrequest`; return `providerRef = CheckoutRequestID` (no `tradeNO`).
   - `inquire`: `POST /mpesa/stkpushquery/v1/query`.
   - `handleNotify`: parse `Body.stkCallback`; `ResultCode === 0` means `PAID`; ack with `{ ResultCode: 0, ResultDesc: 'Accepted' }`.
2. Add `case 'daraja'` in the `app.module.ts` factory.
3. Add `DARAJA_*` variables to `.env`.

No changes are needed in the service, the controllers or the Mini App client, except that with no `tradeNO` the client skips `my.tradePay` and just polls `/orders/:id`.

---

## Checklist

- [ ] `rawBody: true` enabled (signature verification)
- [ ] Gateway domain whitelisted in Domain Preference
- [ ] Notify handler is idempotent (only updates `PENDING`)
- [ ] Client never trusts `resultCode` alone — always checks `/orders/:id`
- [ ] Keys and `.env` git-ignored
- [ ] Replace the in-memory store with a DB before production
