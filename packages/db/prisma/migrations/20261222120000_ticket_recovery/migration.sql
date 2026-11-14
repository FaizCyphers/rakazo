-- Additive: a stuck ticket's recovery state.
ALTER TABLE "tickets" ADD COLUMN "recovery" JSONB;
