import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { LabFeature } from "@rakazo/contracts";
import {
  hasLab,
  isTicketCompletedStatus,
  resolveLabs,
  TICKET_STATUSES,
  TicketStatusSchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { coerceTicketAcceptance } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { TicketChangeNotifier } from "./ticket-changes.js";

const COMPLETED_STATUSES = TICKET_STATUSES.filter(isTicketCompletedStatus);

/** Whether a ticket waits on any ticket that is not complete yet. */
export async function waitsOnIncomplete(
  tx: Pick<Prisma.TransactionClient, "ticketDependency">,
  ticketId: string,
): Promise<boolean> {
  const open = await tx.ticketDependency.count({
    where: { ticketId, dependsOnTicket: { status: { notIn: COMPLETED_STATUSES } } },
  });
  return open > 0;
}

/** What the working bot is told when its ticket's work will be checked as its run ends. */
export const TICKET_VERIFY_NOTICE =
  "When your run ends, your work is checked against the ticket's acceptance steps and the ticket is finished for you. End your reply with a short Verification section listing each step as PASS or FAIL with evidence.";

/**
 * Assignment wakes only its current owner, without posting a chat message. `note` follows the
 * prompt, such as what a check of the last run found not done.
 */
export async function wakeTicketAssignee(
  deps: { prisma: PrismaClient; jobs: JobPublisher; deploymentLabs?: readonly LabFeature[] },
  input: { spaceId: string; ticketId: string; botId: string; note?: string },
): Promise<void> {
  const run = await deps.prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findFirst({
      where: { id: input.ticketId, spaceId: input.spaceId, assigneeBotId: input.botId },
      include: { board: { select: { ticketPrefix: true } } },
    });
    if (!ticket) return null;
    const status = TicketStatusSchema.safeParse(ticket.status);
    if (!status.success || isTicketCompletedStatus(status.data)) return null;
    // A ticket waiting on unfinished tickets starts when the last of them completes.
    if (await waitsOnIncomplete(tx, ticket.id)) return null;
    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId, archivedAt: null },
      select: { id: true, userId: true, thread: { select: { id: true } } },
    });
    if (!bot?.thread) return null;
    const owner = await tx.user.findUnique({ where: { id: bot.userId }, select: { labs: true } });
    if (!hasLab(resolveLabs(owner?.labs, deps.deploymentLabs), "board")) return null;
    const checked =
      Boolean(ticket.doneWhen) || coerceTicketAcceptance(ticket.acceptance).length > 0;
    const prompt = [
      `Work on ticket ${ticket.board.ticketPrefix}-${ticket.number}. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. Use ask or approval cards when user input is needed.`,
      ...(checked ? [TICKET_VERIFY_NOTICE] : []),
      ...(input.note ? [input.note] : []),
    ].join("\n\n");
    const task = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId: bot.id,
        threadId: bot.thread.id,
        userId: bot.userId,
        prompt,
        status: "queued",
        ticketId: ticket.id,
      },
    });
    return tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId: bot.id,
        threadId: bot.thread.id,
        userId: bot.userId,
        taskId: task.id,
        trigger: "tickets",
        status: "queued",
      },
    });
  });
  if (!run) return;
  await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
    getLogger().warn("ticket wake deferred to reconciliation", error);
  });
}

/**
 * As a ticket's run starts, a ticket still in To do moves to In progress, so the board shows
 * the work started without the bot moving it. A repeat finds it moved already.
 */
export async function markTicketStarted(
  deps: { prisma: PrismaClient; onTicketChange?: TicketChangeNotifier },
  runId: string,
): Promise<void> {
  const moved = await deps.prisma.$queryRaw<
    Array<{ id: string; boardId: string; spaceId: string; assigneeBotId: string }>
  >`
    UPDATE tickets t SET status = 'doing', "updatedAt" = now()
    FROM runs r JOIN tasks k ON k.id = r."taskId"
    WHERE r.id = ${runId} AND k."ticketId" = t.id AND t.status = 'todo'
      AND t."assigneeBotId" = r."botId"
    RETURNING t.id, t."boardId", t."spaceId", t."assigneeBotId"`;
  for (const ticket of moved) {
    await deps.onTicketChange?.({
      spaceId: ticket.spaceId,
      boardId: ticket.boardId,
      ticketId: ticket.id,
      assigneeBotId: ticket.assigneeBotId,
      wakeAssignee: false,
    });
  }
}
