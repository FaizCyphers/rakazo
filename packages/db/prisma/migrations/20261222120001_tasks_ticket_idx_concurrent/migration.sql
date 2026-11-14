-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- The stuck-ticket sweep finds each ticket's runs by the tasks that worked it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_ticketId_idx" ON "tasks"("ticketId");
