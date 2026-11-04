/*
  Warnings:

  - You are about to drop the `Order` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'AMOUNT_MISMATCH');

-- DropTable
DROP TABLE "Order";

-- DropEnum
DROP TYPE "PayStatus";

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "bookingRef" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "customerref" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "tradeNo" TEXT,
    "paymentUrl" TEXT,
    "paidAmountMinor" BIGINT,
    "paidCurrency" TEXT,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "duplicate" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "lastInquiryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransition" (
    "id" BIGSERIAL NOT NULL,
    "paymentId" TEXT NOT NULL,
    "from" "PaymentStatus",
    "to" "PaymentStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderNotification" (
    "id" BIGSERIAL NOT NULL,
    "bodyHAsh" TEXT NOT NULL,
    "paymentId" TEXT,
    "providerRef" TEXT,
    "signaturevalid" BOOLEAN NOT NULL,
    "headers" JSONB NOT NULL,
    "rawBody" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAd" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestNonce" (
    "nonce" TEXT NOT NULL,
    "expriresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RequestNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerRef_key" ON "Payment"("providerRef");

-- CreateIndex
CREATE INDEX "Payment_status_expiresAt_idx" ON "Payment"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Payment_bookingRef_idx" ON "Payment"("bookingRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_bookingRef_attempt_key" ON "Payment"("bookingRef", "attempt");

-- CreateIndex
CREATE INDEX "PaymentTransition_paymentId_idx" ON "PaymentTransition"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderNotification_bodyHAsh_key" ON "ProviderNotification"("bodyHAsh");

-- CreateIndex
CREATE INDEX "OutboxEvent_deliveredAt_nextAttemptAt_idx" ON "OutboxEvent"("deliveredAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "RequestNonce_expriresAt_idx" ON "RequestNonce"("expriresAt");

-- AddForeignKey
ALTER TABLE "PaymentTransition" ADD CONSTRAINT "PaymentTransition_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one open (PENDING) payment per booking
CREATE UNIQUE INDEX "payment_one_open_per_booking"
    ON "Payment" ("bookingRef")
    WHERE "status" = 'PENDING';