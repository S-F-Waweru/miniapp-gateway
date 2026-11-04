import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(cfg: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: cfg.getOrThrow<string>('DATABASE_URL'),
      }),
    });
  }

  // Connect at startup so a bad DATABASE_URL fails fast instead of on the first request.
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
