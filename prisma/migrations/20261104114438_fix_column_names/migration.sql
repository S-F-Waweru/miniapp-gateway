-- Fix misspelled column names from payments_v1.
-- Hand-written: Prisma generates DROP + ADD COLUMN for renames, which loses data.

-- Payment
ALTER TABLE "Payment" RENAME COLUMN "customerref" TO "customerRef";
ALTER TABLE "Payment" RENAME COLUMN "tradeNo" TO "tradeNO";

-- PaymentTransition: detail is optional
ALTER TABLE "PaymentTransition" ALTER COLUMN "detail" DROP NOT NULL;

-- ProviderNotification
ALTER TABLE "ProviderNotification" RENAME COLUMN "bodyHAsh" TO "bodyHash";
ALTER TABLE "ProviderNotification" RENAME COLUMN "signaturevalid" TO "signatureValid";
ALTER INDEX "ProviderNotification_bodyHAsh_key" RENAME TO "ProviderNotification_bodyHash_key";

-- OutboxEvent
ALTER TABLE "OutboxEvent" RENAME COLUMN "createdAd" TO "createdAt";

-- RequestNonce
ALTER TABLE "RequestNonce" RENAME COLUMN "expriresAt" TO "expiresAt";
ALTER INDEX "RequestNonce_expriresAt_idx" RENAME TO "RequestNonce_expiresAt_idx";
