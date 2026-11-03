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

NestJS 12 app on Express, intended as a gateway for a mini-app payment integration. It is at an early stage: `AppModule` only wires the starter `AppController`/`AppService`, and `src/payments/` and `src/providers/` exist but are empty (planned feature modules).

- **ESM throughout**: `package.json` has `"type": "module"` and tsconfig uses `nodenext`. Relative imports must include the `.js` extension (e.g. `import { AppService } from './app.service.js'`). `main.ts` uses top-level `await`.
- **Request signing** (`src/common/signature.utils.ts`): RSA-SHA256 signing/verification over the canonical string `"<METHOD> <path>\n<clientId>.<timestamp>.<body>"`. The signature header has the form `algorithm=RSA256,keyVersion=1,signature=<url-encoded base64>`. `verifySignature` parses only the `signature=` part of that header.
- **Keys**: RSA key pair lives in `keys/private.pem` / `keys/public.pem`, gitignored (`/keys/**`). Never commit or print them.
- **Lint rules**: `typescript/no-floating-promises` is an error (await or explicitly handle every promise); `no-explicit-any` is off.
- Tests use Vitest globals (`describe`/`it`/`expect` without imports) and `@nestjs/testing`'s `Test.createTestingModule`; e2e tests use supertest against `AppModule`.

## Production telemetry (from AGENTS.md)

Production traces, errors, logs and metrics are meant to go to NestJS Observe, but `ObserveModule` is not yet registered in `src/app.module.ts`, so nothing is sent. `npx @nestjs/observe link` sets it up (installs `@nestjs/observe`, wires `AppModule`/`main.ts`, writes `OBSERVE_APP_KEY`/`OBSERVE_APP_SECRET` to `.env`). For questions about production behavior, work from Observe data (the Observe MCP server: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, or the dashboard's **Copy agent prompt**) rather than the code alone.
