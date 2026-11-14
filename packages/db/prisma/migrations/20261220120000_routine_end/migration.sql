-- A routine can end itself at a deadline, once a run reports its condition met, or after
-- failing in a row. Nullable columns, so the previous release keeps reading and writing rows.
ALTER TABLE "routines" ADD COLUMN "endsAt" TIMESTAMP(3);
ALTER TABLE "routines" ADD COLUMN "until" TEXT;
ALTER TABLE "routines" ADD COLUMN "endedAt" TIMESTAMP(3);
