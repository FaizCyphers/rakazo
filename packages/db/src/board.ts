import type {
  Board,
  Ticket,
  TicketAcceptanceStep,
  TicketComment,
  TicketPriority,
  TicketStatus,
} from "@rakazo/contracts";
import {
  parseTicketRef,
  TicketAcceptanceStepSchema,
  TicketPrioritySchema,
  TicketStatusSchema,
  ticketRef,
} from "@rakazo/contracts";
import type {
  Board as BoardRow,
  Prisma,
  PrismaClient,
  TicketComment as TicketCommentRow,
  Ticket as TicketRow,
} from "./client.js";

/** skipDuplicates tolerates concurrent first opens without aborting their transactions. */
export async function ensureBoard(prisma: PrismaClient, spaceId: string): Promise<BoardRow> {
  const existing = await prisma.board.findUnique({ where: { spaceId } });
  if (existing) return existing;
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { name: true },
  });
  const name = space?.name.trim() || "Board";
  await prisma.board.createMany({ data: [{ spaceId, name }], skipDuplicates: true });
  return prisma.board.findUniqueOrThrow({ where: { spaceId } });
}

export async function listBoards(prisma: PrismaClient, spaceId: string): Promise<BoardRow[]> {
  return prisma.board.findMany({
    where: { spaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * The board's counter is incremented in the same transaction as the insert, so
 * concurrent creates get distinct ascending numbers.
 */
export async function allocateTicketNumber(
  tx: Pick<Prisma.TransactionClient, "board">,
  boardId: string,
): Promise<number> {
  const incremented = await tx.board.update({
    where: { id: boardId },
    data: { nextNumber: { increment: 1 } },
    select: { nextNumber: true },
  });
  return incremented.nextNumber - 1;
}

/** Loads the numbers of the tickets a ticket waits on, for `toTicketDto`. */
export const TICKET_WAITS_ON_INCLUDE = {
  waitsOn: { select: { dependsOnTicket: { select: { number: true } } } },
} satisfies Prisma.TicketInclude;

export type TicketWithWaitsOn = TicketRow & {
  waitsOn?: Array<{ dependsOnTicket: { number: number } }>;
};

export async function findTicket(
  prisma: Pick<PrismaClient, "ticket">,
  spaceId: string,
  board: { id: string; ticketPrefix: string },
  input: { id?: string; ref?: string },
) {
  if (input.id) {
    return prisma.ticket.findFirst({
      where: { id: input.id, spaceId, boardId: board.id },
      include: TICKET_WAITS_ON_INCLUDE,
    });
  }
  const parsed = input.ref ? parseTicketRef(input.ref, board.ticketPrefix) : null;
  if (!parsed) return null;
  return prisma.ticket.findFirst({
    where: { number: parsed.number, spaceId, boardId: board.id },
    include: TICKET_WAITS_ON_INCLUDE,
  });
}

export function toBoardDto(row: BoardRow): Board {
  return {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    ticketPrefix: row.ticketPrefix,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Unknown or legacy status strings fall back to `todo`, so an old row still renders. */
export function coerceTicketStatus(value: string): TicketStatus {
  const parsed = TicketStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "todo";
}

/** Legacy free-text priorities fall back to `normal` so old rows keep rendering. */
function coerceTicketPriority(value: string | null | undefined): TicketPriority {
  const parsed = TicketPrioritySchema.safeParse(typeof value === "string" ? value.trim() : value);
  return parsed.success ? parsed.data : "normal";
}

/** Malformed stored steps are dropped rather than failing the whole ticket. */
export function coerceTicketAcceptance(value: unknown): TicketAcceptanceStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = TicketAcceptanceStepSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function toTicketDto(row: TicketWithWaitsOn, ticketPrefix: string): Ticket {
  return {
    id: row.id,
    boardId: row.boardId,
    spaceId: row.spaceId,
    number: row.number,
    ref: ticketRef(ticketPrefix, row.number),
    title: row.title,
    description: row.description,
    status: coerceTicketStatus(row.status),
    priority: coerceTicketPriority(row.priority),
    assigneeBotId: row.assigneeBotId,
    createdByBotId: row.createdByBotId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    doneWhen: row.doneWhen ?? null,
    acceptance: coerceTicketAcceptance(row.acceptance),
    waitsOn: (row.waitsOn ?? [])
      .map((link) => link.dependsOnTicket.number)
      .sort((a, b) => a - b)
      .map((number) => ticketRef(ticketPrefix, number)),
  };
}

export async function listTicketComments(
  prisma: Pick<PrismaClient, "ticketComment">,
  spaceId: string,
  ticketId: string,
) {
  return prisma.ticketComment.findMany({
    where: { ticketId, spaceId },
    include: { authorBot: { select: { name: true } }, authorUser: { select: { name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export function toTicketCommentDto(
  row: TicketCommentRow & {
    authorBot: { name: string } | null;
    authorUser: { name: string } | null;
  },
): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticketId,
    body: row.body,
    authorBotId: row.authorBotId,
    authorUserId: row.authorUserId,
    authorName: row.authorBot?.name ?? row.authorUser?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
