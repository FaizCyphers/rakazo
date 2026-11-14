-- Additive: what done means, acceptance steps, and which tickets a ticket waits on.
ALTER TABLE "tickets" ADD COLUMN "doneWhen" TEXT;
ALTER TABLE "tickets" ADD COLUMN "acceptance" JSONB;

CREATE TABLE "ticket_dependencies" (
  "ticketId" TEXT NOT NULL,
  "dependsOnTicketId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_dependencies_pkey" PRIMARY KEY ("ticketId", "dependsOnTicketId"),
  CONSTRAINT "ticket_dependencies_not_self" CHECK ("ticketId" <> "dependsOnTicketId"),
  CONSTRAINT "ticket_dependencies_ticketId_fkey" FOREIGN KEY ("ticketId")
    REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ticket_dependencies_dependsOnTicketId_fkey" FOREIGN KEY ("dependsOnTicketId")
    REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ticket_dependencies_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ticket_dependencies_dependsOnTicketId_idx"
  ON "ticket_dependencies"("dependsOnTicketId");

ALTER TABLE "ticket_dependencies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_dependencies_tenant ON "ticket_dependencies"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY ticket_dependencies_system ON "ticket_dependencies"
  USING ((SELECT app_rls_bypass()));
