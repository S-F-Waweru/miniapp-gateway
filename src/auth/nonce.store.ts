import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

export class NonceStore {
  constructor(private readonly db: PrismaService) {}

  /**
   * Records the nonce. Returns false if it was already used.
   * Insert-and-catch, not find-then-insert: two parallel replays can't both pass.
   */

  async claim(nonce: string, ttlMs:number) {
    try {
      await this.db.requestNonce.create({
        data: {nonce, expriresAt: new Date(Date.now()+ttlMs)}
        });

      return true;
    }catch(err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return false;
      }
      throw err;
    }
    }
}