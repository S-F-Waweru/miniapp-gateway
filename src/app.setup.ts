import { HttpStatus, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

/**
 * Everything main.ts applies to the app, shared with e2e tests.
 * The caller must create the app with { rawBody: true }.
 */
export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: '32kb' });
  app.useBodyParser('urlencoded', { limit: '32kb', extended: false });
  app.use(helmet());

  const proxies = Number(process.env.TRUST_PROXY || 0);
  if (proxies > 0) app.set('trust proxy', proxies);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY, // doc §3.1: validation → 422
    }),
  );
}
