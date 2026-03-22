-- AlterTable
ALTER TABLE "terms" ADD COLUMN "is_current" BOOLEAN NOT NULL DEFAULT false;

-- Operational current term (GET /terms/current prefers this over calendar dates)
UPDATE "terms" SET "is_current" = false;
UPDATE "terms" SET "is_current" = true WHERE "name" = '26S';
