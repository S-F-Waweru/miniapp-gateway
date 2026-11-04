import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation } from '../common/prisma-errors.js';

@Injectable()
export class NonceStore {
  constructor(private readonly db: PrismaService) {}

  /**
   * Records the nonce. Returns false if it was already used.
   * Insert-and-catch, not find-then-insert: two parallel replays can't both pass.
   */

  async claim(nonce: string, ttlMs: number) {
    try {
      await this.db.requestNonce.create({
        data: { nonce, expiresAt: new Date(Date.now() + ttlMs) },
      });

      return true;
    } catch (err) {
      if (isUniqueViolation(err)) {
        return false;
      }
      throw err;
    }
  }
}
