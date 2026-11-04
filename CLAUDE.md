# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run start:dev        # watch mode (loads .env; PORT defaults to 3000)
npm run build            # nest build -> dist/ (tsconfig.build.json, excludes specs and test/)
npm run lint             # oxlint --type-aware over src/ and test/
npm run format           # prettier (single quotes, trailing commas)
npm test                 # vitest unit tests (**/*.spec.ts)
npm run test:e2e         # vitest e2e tests (**/*.e2e-spec.ts, config: vitest.config.e2e.ts)
npx vitest run src/app.controller.spec.ts   # single test file
npx vitest run -t "should return"           # single test by name
```

## Architecture

NestJS 12 app on Express: a payments-only gateway between the main backend and M-Pesa (Safaricom). It creates payments, records everything, verifies the outcome, and reports it to the main backend; it never prices, tickets or refunds. Design: `docs/payment-architecture-and-security.md`; per-task study guides: `docs/task-4-settlement.md`, `docs/task-5-outbox.md`, `docs/task-6-reconciler.md`, `docs/task-7-production.md`, `docs/service-auth.md`.

- **Flow**: `PaymentsController` → `PaymentsService` (idempotent create, new-attempt rules, GET refresh) and `NotificationsService` (inbox → settle). Every status change goes through `SettlementService` → `PaymentsStore.transition()`, which locks the booking's rows, decides with the pure rules in `settlement.rules.ts`, and writes status + `PaymentTransition` + `OutboxEvent` in one transaction. Never update `Payment.status` any other way.
- **Background jobs** (`src/jobs/jobs.scheduler.ts`, `BACKGROUND_JOBS=on|off`): `OutboxDispatcher` delivers events (HMAC-signed, retried with backoff, per-payment order); `ReconcilerService` sweeps PENDING payments, expires overdue ones, checks health, cleans nonces. No job-wide locks: each unit of work is safe to run concurrently.
- **Amounts** are whole shillings everywhere (`"1500"` = KES 1,500, `BigInt` in the DB, strings in JSON).
- **Auth**: inbound requests from the main backend use HMAC (`src/auth/`, `SERVICE_HMAC_KEYS`, global guard, `@Public()` to opt out); outbound events use a separate `EVENT_HMAC_KEY`.
- **Alerts**: raise via `AlertService.raise(Alert.X, ...)` (structured log line), never free-text `[ALERT]` logs.
- E2E tests share one database and run files sequentially (`vitest.config.e2e.ts`); use `test/support/test-app.ts` with a unique booking prefix per spec.
- **ESM throughout**: `package.json` has `"type": "module"` and tsconfig uses `nodenext`. Relative imports must include the `.js` extension (e.g. `import { AppService } from './app.service.js'`). `main.ts` uses top-level `await`.
- **Request signing** (`src/common/signature.utils.ts`): RSA-SHA256 signing/verification over the canonical string `"<METHOD> <path>\n<clientId>.<timestamp>.<body>"`. The signature header has the form `algorithm=RSA256,keyVersion=1,signature=<url-encoded base64>`. `verifySignature` parses only the `signature=` part of that header.
- **Database**: PostgreSQL via Prisma 7 (`prisma/schema.prisma`, config in `prisma.config.ts`). The client is generated into `src/generated/prisma` (git-ignored, ESM with `.js` imports); run `npm run db:generate` after schema changes, `npm run db:migrate` to create/apply migrations. Prisma 7 needs the `@prisma/adapter-pg` driver adapter (see `src/prisma/prisma.service.ts`).
- **Provider selection**: `PAYMENT_PROVIDER` is required (`mock` | `mpesa-miniapp`); mock is refused when `NODE_ENV=production`.
- **Keys**: locally the RSA key pair lives in `keys/private.pem` / `keys/public.pem`, gitignored (`/keys/**`); in production keys come from a secret manager via `MP_PRIVATE_KEY` / `MP_PLATFORM_PUBLIC_KEY` (see `src/config/keys.ts`). Never commit or print them.
- **Lint rules**: `typescript/no-floating-promises` is an error (await or explicitly handle every promise); `no-explicit-any` is off.
- Tests use Vitest globals (`describe`/`it`/`expect` without imports) and `@nestjs/testing`'s `Test.createTestingModule`; e2e tests use supertest against `AppModule`.

## Production telemetry (from AGENTS.md)

Production traces, errors, logs and metrics are meant to go to NestJS Observe, but `ObserveModule` is not yet registered in `src/app.module.ts`, so nothing is sent. `npx @nestjs/observe link` sets it up (installs `@nestjs/observe`, wires `AppModule`/`main.ts`, writes `OBSERVE_APP_KEY`/`OBSERVE_APP_SECRET` to `.env`). For questions about production behavior, work from Observe data (the Observe MCP server: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, or the dashboard's **Copy agent prompt**) rather than the code alone.
