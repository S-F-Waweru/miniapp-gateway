import { Prisma } from '../generated/prisma/client.js';

/** Unique constraint violated: some other transaction got there first. */
export const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
