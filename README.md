# M-Pesa Mini App Payment Gateway

> **Archived (November 2026): kept as a case study.** This was never used in production; a simpler solution replaced it. It is still a full worked example of how a payment gateway is built: idempotent payment creation, a settlement state machine, a transactional outbox, a reconciler, HMAC service auth, and RSA request signing.
>
> **What to study**
> - [`docs/payment-architecture-and-security.md`](docs/payment-architecture-and-security.md): the overall design and why each safeguard exists
> - Task guides: [settlement](docs/task-4-settlement.md), [outbox](docs/task-5-outbox.md), [reconciler](docs/task-6-reconciler.md), [production](docs/task-7-production.md), [service auth](docs/service-auth.md)
> - Code: `src/payments/settlement.rules.ts` (pure rules) → `src/payments/payments.store.ts` (`transition()`), `src/outbox/`, `src/reconciler/`
>
> **Known gaps against the [Alipay Mini Program OpenAPI](https://miniprogram.alipay.com/docs-demo/miniprogram_demo/mpdev/v1_pay)** (in `src/providers/mpesa-miniapp.provider.ts`, never fixed):
> - The `pay` response URL is read from `redirectActionForm.redirectUrl`, but the docs return `actionForm.redirectionUrl`.
> - Two fields the docs require for mini programs are not sent: `paymentFactor: { isCashierPayment: true }` and `extendInfo.customerBelongsTo`.
> - `productCode` is a guess, and the docs say the wallet assigns it.
> - The amount unit was never confirmed. The docs' sample suggests minor units (cents), while this code sends whole shillings.
> - An `ORDER_NOT_EXIST` inquiry result throws an error, but the docs say to treat it as a failed payment.
>
> The sections below date from an early version (`/orders` endpoints). The docs and the code are the accurate reference.

A NestJS gateway that sits between an M-Pesa Mini App and the payment provider. It:

- creates orders and returns a `tradeNO` (or `paymentUrl`) for the Mini App's `my.tradePay`
- receives signed payment notifications from the provider and exposes order status
- switches providers with one env variable: `mock` (default) or `mpesa-miniapp`

```
Mini App ──my.request──▶ Gateway /orders ──▶ Provider (mock | M-Pesa)
   │                          ▲                         │
   └── my.tradePay(tradeNO)   └──── /payments/notify ◀──┘
```

The server-side M-Pesa calls follow the **Alipay+ Mini Program OpenAPI** standard that the M-Pesa platform is built on. Lines marked `// CONFIRM` in `src/providers/mpesa-miniapp.provider.ts` must be checked against the server spec Safaricom provides.

The full build walkthrough is in [`docs/miniapp-gateway-guide.md`](docs/miniapp-gateway-guide.md). The production architecture and security measures (idempotency, no double charges, events to the main backend) are in [`docs/payment-architecture-and-security.md`](docs/payment-architecture-and-security.md).

## Setup

```bash
npm install
```

Create `.env`:

```env
PORT=3000
PAYMENT_PROVIDER=mock               # required: mock | mpesa-miniapp (mock is refused when NODE_ENV=production)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/miniapp_gateway?schema=public"
PUBLIC_BASE_URL=https://xxxx.trycloudflare.com

# Only needed for PAYMENT_PROVIDER=mpesa-miniapp
MP_BASE_URL=https://<safaricom-openapi-host>
MP_CLIENT_ID=
MP_MERCHANT_ID=
MP_APP_ID=
MP_PRIVATE_KEY_PATH=./keys/private.pem
MP_PLATFORM_PUBLIC_KEY_PATH=./keys/safaricom_public.pem
```

For real M-Pesa, generate an RSA key pair, upload `keys/public.pem` in **Key Manage** on the Mini Program Platform, and save Safaricom's public key as `keys/safaricom_public.pem`:

```bash
mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem
```

`keys/` and `.env` are git-ignored.

### Database

Orders are stored in PostgreSQL via Prisma (schema: `prisma/schema.prisma`).

```bash
docker compose up -d     # local Postgres matching the DATABASE_URL above
npm run db:migrate       # apply migrations (dev); creates new ones after schema changes
npm run db:generate      # regenerate the client into src/generated/prisma (also runs on build)
```

In production, run `npm run db:deploy` to apply migrations without creating new ones.

## Run

```bash
npm run start:dev      # watch mode
npm run build && npm run start:prod
```

To receive notifications from the provider, expose the gateway publicly and put the URL in `PUBLIC_BASE_URL`:

```bash
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```

Then add the gateway domain under **Settings → Domain Preference** on the Mini Program Platform; `my.request` is blocked otherwise.

## API

| Method | Path                   | Purpose                                                        |
| ------ | ---------------------- | -------------------------------------------------------------- |
| POST   | `/orders`              | Create an order: `{ "amount": 100, "title": "...", "userId"? }` |
| GET    | `/orders/:id`          | Order status; asks the provider if still `PENDING`             |
| POST   | `/payments/notify`     | Provider payment notification (signature-verified)             |
| POST   | `/mock/pay/:tradeNO`   | Mock mode only: simulate payment, `{ "status": "PAID" \| "FAILED" }` |

## Testing

```bash
npm test               # unit tests (*.spec.ts)
npm run test:e2e       # e2e tests (test/*.e2e-spec.ts)
npm run lint
```

Manual flow in mock mode: open `test.http` in WebStorm and run the three requests in order (create order → simulate payment → check status). Each request saves the IDs the next one needs and asserts on the response.

## How it fits together

- `src/providers/payment.provider.interface.ts`: the `PaymentProvider` contract (`createPayment`, `inquire`, `handleNotify`) every provider implements.
- `src/providers/mock.provider.ts`: in-memory provider for local development.
- `src/providers/mpesa-miniapp.provider.ts`: real M-Pesa provider; signs requests and verifies notifications with RSA-SHA256 (`src/common/signature.utils.ts`).
- `src/app.module.ts`: picks the provider from `PAYMENT_PROVIDER` and registers `MockController` only in mock mode.
- `src/payments/`: orders/notify controllers and `PaymentsService`. `MockController` returns 404 unless the mock provider is active.
- Notifications are rejected (401) on a bad or malformed signature, or a `Request-Time` more than 5 minutes off. Responses from M-Pesa are signature-checked too.
- `src/orders/orders.store.ts`: order persistence through `PrismaService` (`src/prisma/`). `settleIfPending` changes status in a single conditional UPDATE, so duplicate or late notifications can't overwrite a final status.

To add another gateway (e.g. Daraja STK Push), implement `PaymentProvider` in a new file under `src/providers/` and add a `case` to the factory in `src/app.module.ts`. See section 16 of the guide.

## Switching to real M-Pesa

1. Get the Client ID, Merchant ID and App ID, and exchange keys in **Workspace → App Manage / Key Manage**.
2. Get the server-side payment spec from Safaricom and resolve every `// CONFIRM` line.
3. Set `PAYMENT_PROVIDER=mpesa-miniapp` and fill in the `MP_*` variables.
4. Test inside the M-Pesa app with a whitelisted tester (**Settings → Whitelist for Testers**).

## Before production

- [ ] Gateway domain whitelisted in Domain Preference
- [ ] Mini App client always confirms via `/orders/:id`, never trusts the `my.tradePay` result alone
- [ ] Server-side pricing and user authentication for `POST /orders` (currently trusts the client's `amount` and `userId`)
