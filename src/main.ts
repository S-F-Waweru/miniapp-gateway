import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

/**
 * JSON logs in production (one object per line, for log platforms and alert
 * rules), readable coloured text in development. LOG_FORMAT=json|text overrides.
 */
function createLogger(): ConsoleLogger {
  const format =
    process.env.LOG_FORMAT ??
    (process.env.NODE_ENV === 'production' ? 'json' : 'text');
  const json = format === 'json';
  return new ConsoleLogger({ json, colors: !json });
}

async function bootstrap() {
  // rawBody: signatures (HMAC and Safaricom RSA) are verified against the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: createLogger(),
  });

  configureApp(app);
  // No enableCors(): server-to-server API. Browsers have no business calling it.
  // SIGTERM: stop background jobs, let running ones finish, disconnect Prisma.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
