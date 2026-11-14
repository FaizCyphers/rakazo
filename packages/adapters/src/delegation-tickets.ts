import type { LabFeature } from "@rakazo/contracts";
import {
  hasLab,
  isTicketCompletedStatus,
  resolveLabs,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
  ticketRef,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { allocateTicketNumber, coerceTicketAcceptance, ensureBoard } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { extractTicketRefs } from "./ticket-context.js";
import { sliceWellFormed } from "./utf8.js";

const COMPLETED_STATUSES = TICKET_STATUSES.filter(isTicketCompletedStatus);

export type DelegationBoard = { id: string; ticketPrefix: string; ownerId: string };

/** The ticket a delegation is tracked as. `checked` tickets are finished by the server's check. */
export type DelegationTicket = { id: string; boardId: string; ref: string; checked: boolean };

/**
 * The board a bot's delegations are tracked on: the space's board when its owner has the board
 * lab, otherwise null and nothing is tracked.
 */
export async function delegationBoard(
  deps: { prisma: PrismaClient; deploymentLabs?: readonly LabFeature[] },
  input: { spaceId: string; botId: string },
): Promise<DelegationBoard | null> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, spaceId: input.spaceId },
    select: { userId: true },
  });
  if (!bot) return null;
  const owner = await deps.prisma.user.findUnique({
    where: { id: bot.userId },
    select: { labs: true },
  });
  if (!hasLab(resolveLabs(owner?.labs, deps.deploymentLabs), "board")) return null;
  const board = await ensureBoard(deps.prisma, input.spaceId);
  return { id: board.id, ticketPrefix: board.ticketPrefix, ownerId: bot.userId };
}

/** A ticket title from a delegated message: its first line, cut to the title limit. */
export function delegationTitle(message: string): string {
  const line =
    message
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  if (line.length <= TICKET_TITLE_MAX_LENGTH) return line;
  return `${sliceWellFormed(line, TICKET_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/** The line put before a delegated message, naming its ticket. */
export function delegationNotice(ticket: Pick<DelegationTicket, "ref" | "checked">): string {
  return ticket.checked
    ? `Tracked as ${ticket.ref}. Keep progress in its comments; it is checked when your run ends.`
    : `Tracked as ${ticket.ref}. Keep progress in its comments and move it to done, review or blocked when finished.`;
}

/**
 * Inside the transaction that delivers a delegation: the open ticket the message names that is
 * already the target's, or a new one in progress for it. Only the owner's own bots are tracked,
 * as only they can own the owner's tickets.
 */
export async function trackDelegation(
  tx: Prisma.TransactionClient,
  board: DelegationBoard,
  input: { spaceId: string; userId: string; fromBotId: string; toBotId: string; message: string },
): Promise<DelegationTicket | null> {
  const target = await tx.bot.findFirst({
    where: { id: input.toBotId, spaceId: input.spaceId, userId: board.ownerId, archivedAt: null },
    select: { id: true },
  });
  if (!target) return null;
  const numbers = extractTicketRefs(input.message, board.ticketPrefix).map((ref) =>
    Number(ref.slice(ref.lastIndexOf("-") + 1)),
  );
  const named = numbers.length
    ? await tx.ticket.findMany({
        where: {
          boardId: board.id,
          spaceId: input.spaceId,
          number: { in: numbers },
          assigneeBotId: input.toBotId,
          status: { notIn: COMPLETED_STATUSES },
        },
        select: { id: true, number: true, doneWhen: true, acceptance: true },
      })
    : [];
  const existing = numbers
    .map((number) => named.find((row) => row.number === number))
    .find(Boolean);
  const row =
    existing ??
    (await tx.ticket.create({
      data: {
        boardId: board.id,
        spaceId: input.spaceId,
        number: await allocateTicketNumber(tx, board.id),
        title: delegationTitle(input.message),
        // A bot message is well under the description limit.
        description: input.message,
        status: "doing",
        assigneeBotId: input.toBotId,
        createdByBotId: input.fromBotId,
        createdByUserId: input.userId,
      },
      select: { id: true, number: true, doneWhen: true, acceptance: true },
    }));
  return {
    id: row.id,
    boardId: board.id,
    ref: ticketRef(board.ticketPrefix, row.number),
    checked: Boolean(row.doneWhen) || coerceTicketAcceptance(row.acceptance).length > 0,
  };
}

/** Shows a delegation's ticket on the board. Its run is already queued, so nothing is woken. */
export async function showDelegationTicket(
  deps: Pick<ExecutorDeps, "onTicketChange">,
  spaceId: string,
  ticket: DelegationTicket,
  assigneeBotId: string,
) {
  await deps
    .onTicketChange?.({
      spaceId,
      boardId: ticket.boardId,
      ticketId: ticket.id,
      assigneeBotId,
      wakeAssignee: false,
    })
    .catch((error) => getLogger().error("delegation ticket notification", error));
}
