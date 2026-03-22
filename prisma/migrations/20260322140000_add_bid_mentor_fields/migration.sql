-- AlterTable
ALTER TABLE "bids" ADD COLUMN "mentor_id" UUID,
                   ADD COLUMN "external_mentor" VARCHAR(255);

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_mentor_id_fkey"
  FOREIGN KEY ("mentor_id") REFERENCES "members"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "bids_mentor_id_idx" ON "bids"("mentor_id");
