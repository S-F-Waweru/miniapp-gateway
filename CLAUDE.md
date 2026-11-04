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

NestJS 12 app on Express: a payment gateway between an M-Pesa Mini App and the payment provider (see `README.md` and `docs/miniapp-gateway-guide.md`). Providers implement `PaymentProvider` (`src/providers/payment.provider.interface.ts`) and are chosen by a factory in `src/app.module.ts`; `PaymentsService` (`src/payments/payament.service.ts`, filename typo) orchestrates orders, provider calls and notifications.

- **ESM throughout**: `package.json` has `"type": "module"` and tsconfig uses `nodenext`. Relative imports must include the `.js` extension (e.g. `import { AppService } from './app.service.js'`). `main.ts` uses top-level `await`.
- **Request signing** (`src/common/signature.utils.ts`): RSA-SHA256 signing/verification over the canonical string `"<METHOD> <path>\n<clientId>.<timestamp>.<body>"`. The signature header has the form `algorithm=RSA256,keyVersion=1,signature=<url-encoded base64>`. `verifySignature` parses only the `signature=` part of that header.
- **Database**: PostgreSQL via Prisma 7 (`prisma/schema.prisma`, config in `prisma.config.ts`). The client is generated into `src/generated/prisma` (git-ignored, ESM with `.js` imports); run `npm run db:generate` after schema changes, `npm run db:migrate` to create/apply migrations. Prisma 7 needs the `@prisma/adapter-pg` driver adapter (see `src/prisma/prisma.service.ts`).
- **Provider selection**: `PAYMENT_PROVIDER` is required (`mock` | `mpesa-miniapp`); mock is refused when `NODE_ENV=production`.
- **Keys**: RSA key pair lives in `keys/private.pem` / `keys/public.pem`, gitignored (`/keys/**`). Never commit or print them.
- **Lint rules**: `typescript/no-floating-promises` is an error (await or explicitly handle every promise); `no-explicit-any` is off.
- Tests use Vitest globals (`describe`/`it`/`expect` without imports) and `@nestjs/testing`'s `Test.createTestingModule`; e2e tests use supertest against `AppModule`.

## Production telemetry (from AGENTS.md)

Production traces, errors, logs and metrics are meant to go to NestJS Observe, but `ObserveModule` is not yet registered in `src/app.module.ts`, so nothing is sent. `npx @nestjs/observe link` sets it up (installs `@nestjs/observe`, wires `AppModule`/`main.ts`, writes `OBSERVE_APP_KEY`/`OBSERVE_APP_SECRET` to `.env`). For questions about production behavior, work from Observe data (the Observe MCP server: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, or the dashboard's **Copy agent prompt**) rather than the code alone.
