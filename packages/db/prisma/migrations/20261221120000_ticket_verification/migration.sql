-- Additive: checking a finished ticket run's work, and the board's sign-off option.
ALTER TABLE "tasks" ADD COLUMN "ticketId" TEXT;
ALTER TABLE "tickets" ADD COLUMN "verification" JSONB;
ALTER TABLE "tickets" ADD COLUMN "verifyFailures" INTEGER;
ALTER TABLE "boards" ADD COLUMN "requireSignOff" BOOLEAN;
