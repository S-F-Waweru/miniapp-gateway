import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  // rawBody: signatures (HMAC and Safaricom RSA) are verified against the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Small bodies only. Payment requests and notifications are a few hundred bytes.
  app.useBodyParser('json', { limit: '32kb' });
  app.useBodyParser('urlencoded', { limit: '32kb', extended: false });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields
      forbidNonWhitelisted: true, // ...and reject the request instead of silently stripping
      transform: true,
    }),
  );

  // No enableCors(): server-to-server API. Browsers have no business calling it.
  app.enableShutdownHooks(); // runs onModuleDestroy (Prisma disconnect) on SIGTERM
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
