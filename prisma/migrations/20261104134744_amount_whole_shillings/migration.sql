-- Amounts are whole shillings ("1500" = KES 1,500), the unit the main backend
-- sends and Safaricom uses. Renamed from *Minor (cents). Hand-written as RENAME:
-- Prisma would generate DROP + ADD and lose data.
-- No value conversion: the table was empty when this ran (never deployed).
ALTER TABLE "Payment" RENAME COLUMN "amountMinor" TO "amount";
ALTER TABLE "Payment" RENAME COLUMN "paidAmountMinor" TO "paidAmount";
