-- Drop old FK and column, add new member_id column and FK
ALTER TABLE "access_group_members" DROP CONSTRAINT IF EXISTS "access_group_members_user_id_fkey";
ALTER TABLE "access_group_members" DROP COLUMN IF EXISTS "user_id";

ALTER TABLE "access_group_members" ADD COLUMN "member_id" UUID NOT NULL DEFAULT gen_random_uuid();

-- Re-create primary key
ALTER TABLE "access_group_members" DROP CONSTRAINT IF EXISTS "access_group_members_pkey";
ALTER TABLE "access_group_members" ADD CONSTRAINT "access_group_members_pkey" PRIMARY KEY ("group_id", "member_id");

-- Drop old index, add new one
DROP INDEX IF EXISTS "access_group_members_user_id_idx";
CREATE INDEX "access_group_members_member_id_idx" ON "access_group_members"("member_id");

-- Add FK to members
ALTER TABLE "access_group_members" ADD CONSTRAINT "access_group_members_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
