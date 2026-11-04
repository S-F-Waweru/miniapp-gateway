-- CreateEnum
CREATE TYPE "PayStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "title" TEXT NOT NULL,
    "userId" TEXT,
    "status" "PayStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_providerRef_key" ON "Order"("providerRef");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");



