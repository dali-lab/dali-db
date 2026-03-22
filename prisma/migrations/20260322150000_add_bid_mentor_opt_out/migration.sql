-- AlterTable: add nullable mentor_opt_out (null = not overridden, true = opted out, false = forced in)
ALTER TABLE "bids" ADD COLUMN "mentor_opt_out" BOOLEAN;
