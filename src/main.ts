import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  // rawBody: notify signatures are verified against the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
