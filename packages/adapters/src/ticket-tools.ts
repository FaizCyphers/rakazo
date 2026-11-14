import type { TicketStatus } from "@rakazo/contracts";
import {
  CommentTicketInput,
  CreateTicketInput,
  isTicketCompletedStatus,
  parseTicketRef,
  TicketPlanInput,
  TicketStatusSchema,
  ticketRef,
  UpdateTicketInput,
} from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  allocateTicketNumber,
  coerceTicketStatus,
  ensureBoard,
  findTicket,
  listTicketComments,
  TICKET_WAITS_ON_INCLUDE,
  toTicketCommentDto,
  toTicketDto,
} from "@rakazo/db";
import type { FleetCardSummary } from "./approval-ask.js";
import { MAX_APPROVAL_DETAIL_LENGTH, MAX_APPROVAL_SUMMARY_LENGTH } from "./approval-ask.js";
import type { TicketChangeNotifier } from "./ticket-changes.js";
import { waitsOnIncomplete } from "./ticket-wake.js";
import { sliceWellFormed } from "./utf8.js";

type TicketToolDeps = {
  prisma: PrismaClient;
  onTicketChange?: TicketChangeNotifier;
};

function ticketInputError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues
    .map(({ path, message }) => {
      const field =
        path[0] === "ticketId"
          ? "id"
          : path.map((part) => (part === "assigneeBotId" ? "ownerBotId" : String(part))).join(".");
      return field ? `${field}: ${message}` : message;
    })
    .join("; ");
}

type Tx = Prisma.TransactionClient;
type BoardRef = { id: string; ticketPrefix: string };
type Prerequisite = { id: string; number: number; status: string };

/**
 * Finds the tickets `refs` name (a ref such as RAK-3, or an id) on this board and holds them
 * with a share lock until the transaction ends. A prerequisite completing at the same time then
 * either commits first, so the status read here sees it, or waits until this transaction has
 * committed its links, so its own dependent check sees them. Either way the ticket wakes once.
 */
async function lockPrerequisites(
  tx: Pick<Tx, "$queryRaw">,
  spaceId: string,
  board: BoardRef,
  refs: readonly string[],
): Promise<Prerequisite[]> {
  if (refs.length === 0) return [];
  const numbers = refs.flatMap((ref) => {
    const parsed = parseTicketRef(ref, board.ticketPrefix);
    return parsed ? [parsed.number] : [];
  });
  const found = await tx.$queryRaw<Prerequisite[]>`
    SELECT id, number, status FROM tickets
    WHERE "spaceId" = ${spaceId} AND "boardId" = ${board.id}
      AND (id = ANY(${[...refs]}::text[]) OR number = ANY(${numbers}::int[]))
    ORDER BY id
    FOR SHARE`;
  const rows: Prerequisite[] = [];
  for (const ref of refs) {
    const number = parseTicketRef(ref, board.ticketPrefix)?.number;
    const row = found.find((item) => item.id === ref || item.number === number);
    if (!row) throw new TicketRefusal(`Unknown ticket ${ref} in waitsOn.`);
    rows.push(row);
  }
  return rows;
}

/** Thrown inside a transaction to roll it back and return `message` to the caller. */
class TicketRefusal extends Error {}

async function refusing<T>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TicketRefusal) return { error: error.message };
    throw error;
  }
}

function allComplete(rows: ReadonlyArray<{ status: string }>): boolean {
  return rows.every((row) => isTicketCompletedStatus(coerceTicketStatus(row.status)));
}

/** Whether waiting on `dependsOnIds` closes a loop: one of them already waits on `ticketId`. */
async function wouldCycle(
  tx: Pick<Tx, "$queryRaw">,
  ticketId: string,
  dependsOnIds: readonly string[],
): Promise<boolean> {
  if (dependsOnIds.includes(ticketId)) return true;
  if (dependsOnIds.length === 0) return false;
  const found = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE reach(id) AS (
      SELECT unnest(${[...dependsOnIds]}::text[])
      UNION
      SELECT d."dependsOnTicketId" FROM ticket_dependencies d JOIN reach r ON d."ticketId" = r.id
    )
    SELECT id FROM reach WHERE id = ${ticketId} LIMIT 1`;
  return found.length > 0;
}

/**
 * The tickets waiting on `ticketId` that can start now that it is complete. Each is locked, so
 * two prerequisites completing at once queue here, and the second sees the first one's commit.
 */
async function readyDependents(
  tx: Pick<Tx, "$queryRaw" | "ticketDependency">,
  ticketId: string,
): Promise<Array<{ id: string; assigneeBotId: string }>> {
  const waiting = await tx.$queryRaw<Array<{ id: string; assigneeBotId: string }>>`
    SELECT t.id, t."assigneeBotId" FROM tickets t
    JOIN ticket_dependencies d ON d."ticketId" = t.id
    WHERE d."dependsOnTicketId" = ${ticketId} AND t.status = 'todo'
      AND t."assigneeBotId" IS NOT NULL
    ORDER BY t.id
    FOR UPDATE OF t`;
  const ready: Array<{ id: string; assigneeBotId: string }> = [];
  for (const row of waiting) if (!(await waitsOnIncomplete(tx, row.id))) ready.push(row);
  return ready;
}

const STATUS_ERROR = `status must be one of ${TicketStatusSchema.options.join(", ")}.`;
function coerceInputStatus(value: string) {
  const parsed = TicketStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
/**
 * An assignee must be one of the acting user's own bots, as the HTTP API
 * requires through `repos.getBot`. Assigning wakes the bot, which runs as its
 * owner, so another member's bot in the same space is not a valid target.
 */
async function ownBotInSpace(
  deps: TicketToolDeps,
  input: { spaceId: string; userId: string },
  botId: string,
) {
  return Boolean(
    await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: input.spaceId, userId: input.userId, archivedAt: null },
      select: { id: true },
    }),
  );
}
const LIST_TICKETS_LIMIT = 50;
const LIST_DESCRIPTION_CHARS = 200;

/**
 * The page key is the ticket's `createdAt` with `id` as the tiebreaker, because
 * both never change. A key on `updatedAt` would move a ticket that is edited
 * while a bot pages the board: the ticket would end up above the saved cursor
 * and no later page could return it. A stable key keeps the scan complete.
 */
function encodeTicketListCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeTicketListCursor(
  cursor: string,
): { createdAt: Date; id: string } | { error: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return { error: "cursor is invalid." };
  }
  const split = raw.indexOf("|");
  if (split <= 0) return { error: "cursor is invalid." };
  const createdAt = new Date(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return { error: "cursor is invalid." };
  return { createdAt, id };
}

function truncateDescription(value: string | null | undefined) {
  if (!value || value.length <= LIST_DESCRIPTION_CHARS) return value;
  return `${sliceWellFormed(value, LIST_DESCRIPTION_CHARS - 1)}…`;
}

export async function listBoardTickets(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    status?: string;
    assigneeBotId?: string;
    cursor?: string;
  },
) {
  let status: TicketStatus | undefined;
  if (input.status !== undefined) {
    status = coerceInputStatus(input.status);
    if (!status) return { error: STATUS_ERROR };
  }
  const cursor = input.cursor?.trim();
  let pageCursor: { createdAt: Date; id: string } | undefined;
  if (cursor) {
    const decoded = decodeTicketListCursor(cursor);
    if ("error" in decoded) return decoded;
    pageCursor = decoded;
  }
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const rows = await deps.prisma.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      boardId: board.id,
      // Closed tickets are history; they only show up when asked for by status.
      ...(status ? { status } : { status: { not: "closed" } }),
      ...(input.assigneeBotId ? { assigneeBotId: input.assigneeBotId } : {}),
      ...(pageCursor
        ? {
            OR: [
              { createdAt: { lt: pageCursor.createdAt } },
              { createdAt: pageCursor.createdAt, id: { lt: pageCursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LIST_TICKETS_LIMIT + 1,
  });
  const page = rows.slice(0, LIST_TICKETS_LIMIT);
  const next = rows.length > LIST_TICKETS_LIMIT ? page.at(-1) : undefined;
  // A list is for scanning; ticket_get returns the full description.
  return {
    tickets: page.map((row) => {
      const dto = toTicketDto(row, board.ticketPrefix);
      return { ...dto, description: truncateDescription(dto.description) };
    }),
    ...(next ? { nextCursor: encodeTicketListCursor(next) } : {}),
  };
}

export async function getTicket(deps: TicketToolDeps, input: { spaceId: string; ref: string }) {
  const ref = input.ref.trim();
  if (!ref) return { error: "ref is required." };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const row =
    (await findTicket(deps.prisma, input.spaceId, board, { ref })) ??
    (await findTicket(deps.prisma, input.spaceId, board, { id: ref }));
  if (!row) return { error: `Ticket ${ref} not found.` };
  const comments = await listTicketComments(deps.prisma, input.spaceId, row.id);
  return {
    ticket: toTicketDto(row, board.ticketPrefix),
    comments: comments.map(toTicketCommentDto),
  };
}

type AcceptanceArg = Array<{ text?: unknown; checked?: unknown }> | undefined;

export async function createTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId: string;
    title: string;
    description?: string;
    priority?: string;
    ownerBotId?: string;
    doneWhen?: string;
    acceptance?: AcceptanceArg;
    waitsOn?: string[];
  },
) {
  const parsed = CreateTicketInput.safeParse({
    ...input,
    assigneeBotId: input.ownerBotId ?? input.botId,
  });
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const data = parsed.data;
  if (!(await ownBotInSpace(deps, input, data.assigneeBotId))) return { error: "Unknown bot." };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const result = await refusing(() =>
    deps.prisma.$transaction(async (tx) => {
      // The board row first, then prerequisites, in the same order as updateTicket.
      const number = await allocateTicketNumber(tx, board.id);
      const prerequisites = await lockPrerequisites(tx, input.spaceId, board, data.waitsOn ?? []);
      const row = await tx.ticket.create({
        data: {
          boardId: board.id,
          spaceId: input.spaceId,
          number,
          title: data.title,
          description: data.description ?? null,
          priority: data.priority,
          assigneeBotId: data.assigneeBotId,
          createdByBotId: input.botId ?? null,
          createdByUserId: input.userId,
          doneWhen: data.doneWhen ?? null,
          ...(data.acceptance?.length ? { acceptance: data.acceptance } : {}),
          ...(prerequisites.length
            ? {
                waitsOn: {
                  create: prerequisites.map((row) => ({
                    dependsOnTicketId: row.id,
                    spaceId: input.spaceId,
                  })),
                },
              }
            : {}),
        },
        include: TICKET_WAITS_ON_INCLUDE,
      });
      return { row, ready: allComplete(prerequisites) };
    }),
  );
  if ("error" in result) return result;
  const { row, ready } = result;
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: row.id,
    assigneeBotId: row.assigneeBotId,
    wakeAssignee: ready && row.assigneeBotId !== input.botId,
  });
  return { ticket: toTicketDto(row, board.ticketPrefix) };
}

export async function updateTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId: string;
    id: string;
    title?: string;
    description?: string | null;
    priority?: string | null;
    status?: string;
    ownerBotId?: string;
    doneWhen?: string | null;
    acceptance?: AcceptanceArg;
    waitsOn?: string[];
  },
) {
  const parsed = UpdateTicketInput.safeParse({ ...input, assigneeBotId: input.ownerBotId });
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const data = parsed.data;
  if (data.assigneeBotId && !(await ownBotInSpace(deps, input, data.assigneeBotId)))
    return { error: "Unknown bot." };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const result = await refusing(() =>
    deps.prisma.$transaction(async (tx) => {
      let prerequisites: Prerequisite[] | undefined;
      if (data.waitsOn !== undefined) {
        // Serializes link changes on the board, so two edits cannot close a cycle between them.
        await tx.$queryRaw`SELECT id FROM boards WHERE id = ${board.id} FOR UPDATE`;
        prerequisites = await lockPrerequisites(tx, input.spaceId, board, data.waitsOn);
      }
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${data.id} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
      const current = await tx.ticket.findFirst({
        where: { id: data.id, spaceId: input.spaceId, boardId: board.id },
      });
      if (!current) throw new TicketRefusal("Ticket not found.");
      let unblocked = false;
      if (prerequisites) {
        const ids = prerequisites.map((row) => row.id);
        if (await wouldCycle(tx, current.id, ids))
          throw new TicketRefusal("waitsOn would make tickets wait on each other.");
        const wasWaiting = await waitsOnIncomplete(tx, current.id);
        await tx.ticketDependency.deleteMany({ where: { ticketId: current.id } });
        if (ids.length)
          await tx.ticketDependency.createMany({
            data: ids.map((dependsOnTicketId) => ({
              ticketId: current.id,
              dependsOnTicketId,
              spaceId: input.spaceId,
            })),
          });
        unblocked = wasWaiting && allComplete(prerequisites);
      }
      const completing =
        data.status !== undefined &&
        isTicketCompletedStatus(data.status) &&
        !isTicketCompletedStatus(coerceTicketStatus(current.status));
      const row = await tx.ticket.update({
        where: { id: current.id },
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.priority !== undefined ? { priority: data.priority ?? "normal" } : {}),
          ...(data.assigneeBotId !== undefined ? { assigneeBotId: data.assigneeBotId } : {}),
          ...(data.doneWhen !== undefined ? { doneWhen: data.doneWhen } : {}),
          ...(data.acceptance !== undefined ? { acceptance: data.acceptance } : {}),
          ...(data.status !== undefined
            ? {
                status: data.status,
                completedAt: isTicketCompletedStatus(data.status)
                  ? (current.completedAt ?? new Date())
                  : null,
              }
            : {}),
        },
        include: TICKET_WAITS_ON_INCLUDE,
      });
      return {
        row,
        reassigned:
          data.assigneeBotId !== undefined && data.assigneeBotId !== current.assigneeBotId,
        unblocked: unblocked && row.status === "todo",
        dependents: completing ? await readyDependents(tx, row.id) : [],
      };
    }),
  );
  if ("error" in result) return result;
  const { row } = result;
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: row.id,
    assigneeBotId: row.assigneeBotId,
    wakeAssignee: (result.reassigned || result.unblocked) && row.assigneeBotId !== input.botId,
  });
  // Their prerequisites are all complete now, so their owners start on them.
  for (const dependent of result.dependents) {
    await deps.onTicketChange?.({
      spaceId: input.spaceId,
      boardId: board.id,
      ticketId: dependent.id,
      assigneeBotId: dependent.assigneeBotId,
      wakeAssignee: true,
    });
  }
  return { ticket: toTicketDto(row, board.ticketPrefix) };
}

export async function commentTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId?: string;
    id: string;
    body: string;
  },
) {
  const parsed = CommentTicketInput.safeParse({ ticketId: input.id, body: input.body });
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const ticket = await findTicket(deps.prisma, input.spaceId, board, { id: input.id });
  if (!ticket) return { error: "Ticket not found." };
  const row = await deps.prisma.$transaction(async (tx) => {
    const comment = await tx.ticketComment.create({
      include: { authorBot: { select: { name: true } }, authorUser: { select: { name: true } } },
      data: {
        ticketId: ticket.id,
        spaceId: input.spaceId,
        authorBotId: input.botId ?? null,
        authorUserId: input.userId ?? null,
        body: parsed.data.body,
      },
    });
    await tx.ticket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });
    return comment;
  });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: ticket.id,
    assigneeBotId: ticket.assigneeBotId,
    wakeAssignee: false,
  });
  return { comment: toTicketCommentDto(row) };
}

export type TicketPlanScope = { spaceId: string; userId: string; botId: string };

type ResolvedPlan = {
  board: BoardRef;
  tickets: Array<
    Omit<TicketPlanInput["tickets"][number], "waitsOn"> & {
      ownerName: string;
      /** Indexes of other tickets in this plan. */
      waitsOnPlan: number[];
      /** Refs of tickets already on the board. */
      waitsOnBoard: string[];
    }
  >;
};

/** Tool arguments name the owner `ownerBotId`, which defaults to the calling bot. */
function planArgs(args: Record<string, unknown>, botId: string) {
  const { tickets } = args;
  if (!Array.isArray(tickets)) return { tickets };
  return {
    tickets: tickets.map((item) => {
      if (!item || typeof item !== "object") return item;
      const { ownerBotId, ...rest } = item as Record<string, unknown>;
      return { ...rest, assigneeBotId: ownerBotId ?? botId };
    }),
  };
}

/** The first cycle among plan tickets, as indexes, or undefined. */
export function planCycle(edges: number[][]): number[] | undefined {
  const state: Array<"visiting" | "done" | undefined> = [];
  const path: number[] = [];
  const visit = (node: number): number[] | undefined => {
    if (state[node] === "done") return undefined;
    if (state[node] === "visiting") return [...path.slice(path.indexOf(node)), node];
    state[node] = "visiting";
    path.push(node);
    for (const next of edges[node] ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state[node] = "done";
    return undefined;
  };
  for (let node = 0; node < edges.length; node++) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

/**
 * Validates a plan and resolves everything its approval card names: each owner bot, and every
 * ticket each one waits on, by its place in the plan or its ref on the board.
 */
async function resolveTicketPlan(
  deps: TicketToolDeps,
  scope: TicketPlanScope,
  args: Record<string, unknown>,
): Promise<ResolvedPlan | { error: string }> {
  const parsed = TicketPlanInput.safeParse(planArgs(args, scope.botId));
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const items = parsed.data.tickets;
  const botIds = [...new Set(items.map((item) => item.assigneeBotId))];
  const bots = await deps.prisma.bot.findMany({
    where: { id: { in: botIds }, spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
    select: { id: true, name: true },
  });
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const unknownBot = botIds.find((id) => !names.has(id));
  if (unknownBot) return { error: `Unknown bot ${unknownBot}.` };

  const board = await ensureBoard(deps.prisma, scope.spaceId);
  const keyIndex = new Map(items.map((item, index) => [item.key.toUpperCase(), index]));
  const wanted = new Set<number>();
  const links: Array<{ plan: number[]; board: number[] }> = [];
  for (const [index, item] of items.entries()) {
    const link = { plan: [] as number[], board: [] as number[] };
    for (const entry of item.waitsOn) {
      const planned = keyIndex.get(entry.toUpperCase());
      if (planned === index) return { error: `${item.key} cannot wait on itself.` };
      if (planned !== undefined) {
        link.plan.push(planned);
        continue;
      }
      const ref = parseTicketRef(entry, board.ticketPrefix);
      if (!ref) return { error: `Unknown key or ticket ${entry} in waitsOn of ${item.key}.` };
      link.board.push(ref.number);
      wanted.add(ref.number);
    }
    links.push(link);
  }
  const existing = wanted.size
    ? await deps.prisma.ticket.findMany({
        where: { spaceId: scope.spaceId, boardId: board.id, number: { in: [...wanted] } },
        select: { number: true },
      })
    : [];
  const found = new Set(existing.map((row) => row.number));
  const missing = [...wanted].find((number) => !found.has(number));
  if (missing !== undefined)
    return { error: `Unknown ticket ${ticketRef(board.ticketPrefix, missing)} in waitsOn.` };
  const cycle = planCycle(links.map((link) => link.plan));
  if (cycle) {
    const keys = cycle.map((index) => items[index]?.key).join(" -> ");
    return { error: `These tickets wait on each other: ${keys}.` };
  }
  return {
    board,
    tickets: items.map(({ waitsOn: _waitsOn, ...item }, index) => ({
      ...item,
      ownerName: names.get(item.assigneeBotId) ?? "",
      waitsOnPlan: links[index]?.plan ?? [],
      waitsOnBoard: (links[index]?.board ?? []).map((number) =>
        ticketRef(board.ticketPrefix, number),
      ),
    })),
  };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Resolves a plan before its approval card is shown. The card lists every ticket with its owner
 * and what it waits on; a plan too long to show whole is refused. `canonical` is what the card
 * shows, what the approval stores and what runs.
 */
export async function prepareTicketPlan(
  deps: TicketToolDeps,
  scope: TicketPlanScope,
  args: Record<string, unknown>,
  secrets: readonly string[] = [],
): Promise<{ canonical: Record<string, unknown>; summary: FleetCardSummary } | { error: string }> {
  const plan = await resolveTicketPlan(deps, scope, args);
  if ("error" in plan) return plan;
  const lines = plan.tickets.map((item, index) => {
    const waits = [...item.waitsOnPlan.map((other) => `#${other + 1}`), ...item.waitsOnBoard];
    const after = waits.length ? ` · waits on ${waits.join(", ")}` : "";
    return `${index + 1}. ${singleLine(item.title)} — ${singleLine(item.ownerName)}${after}`;
  });
  const count = plan.tickets.length;
  const summary = { title: count === 1 ? "Create 1 ticket?" : `Create ${count} tickets?`, lines };
  if (
    redactSecrets(summary.title, [...secrets]).length > MAX_APPROVAL_SUMMARY_LENGTH ||
    redactSecrets(lines.join("\n"), [...secrets]).length > MAX_APPROVAL_DETAIL_LENGTH
  ) {
    return { error: "This plan is too long to show on the approval card. Split it up." };
  }
  const canonical = {
    tickets: plan.tickets.map((item) => ({
      key: item.key,
      title: item.title,
      ...(item.description !== undefined ? { description: item.description } : {}),
      priority: item.priority,
      ownerBotId: item.assigneeBotId,
      ...(item.doneWhen !== undefined ? { doneWhen: item.doneWhen } : {}),
      ...(item.acceptance?.length ? { acceptance: item.acceptance } : {}),
      waitsOn: [
        ...item.waitsOnPlan.map((other) => plan.tickets[other]?.key ?? ""),
        ...item.waitsOnBoard,
      ],
    })),
  };
  return { canonical, summary };
}

/** Creates every ticket of an approved plan and the links between them in one transaction. */
export async function createTicketPlan(
  deps: TicketToolDeps,
  scope: TicketPlanScope,
  args: Record<string, unknown>,
) {
  const plan = await resolveTicketPlan(deps, scope, args);
  if ("error" in plan) return plan;
  const { board } = plan;
  const created = await refusing(() =>
    deps.prisma.$transaction(async (tx) => {
      const rows: Array<{ id: string; number: number; assigneeBotId: string | null }> = [];
      for (const item of plan.tickets) {
        const number = await allocateTicketNumber(tx, board.id);
        rows.push(
          await tx.ticket.create({
            data: {
              boardId: board.id,
              spaceId: scope.spaceId,
              number,
              title: item.title,
              description: item.description ?? null,
              priority: item.priority,
              assigneeBotId: item.assigneeBotId,
              createdByBotId: scope.botId,
              createdByUserId: scope.userId,
              doneWhen: item.doneWhen ?? null,
              ...(item.acceptance?.length ? { acceptance: item.acceptance } : {}),
            },
            select: { id: true, number: true, assigneeBotId: true },
          }),
        );
      }
      const boardRefs = [...new Set(plan.tickets.flatMap((item) => item.waitsOnBoard))];
      const prerequisites = await lockPrerequisites(tx, scope.spaceId, board, boardRefs);
      const byRef = new Map(
        prerequisites.map((row) => [ticketRef(board.ticketPrefix, row.number), row]),
      );
      const onBoard = (ref: string) => {
        const row = byRef.get(ref);
        if (!row) throw new TicketRefusal(`Unknown ticket ${ref} in waitsOn.`);
        return row;
      };
      const links = plan.tickets.flatMap((item, index) =>
        [
          ...item.waitsOnPlan.map((other) => rows[other]?.id ?? ""),
          ...item.waitsOnBoard.map((ref) => onBoard(ref).id),
        ].map((dependsOnTicketId) => ({
          ticketId: rows[index]?.id ?? "",
          dependsOnTicketId,
          spaceId: scope.spaceId,
        })),
      );
      if (links.length) await tx.ticketDependency.createMany({ data: links });
      // Tickets in the plan are new, so only one that waits on finished board tickets can start.
      return rows.map((row, index) => {
        const item = plan.tickets[index];
        return {
          ...row,
          ready:
            item !== undefined &&
            item.waitsOnPlan.length === 0 &&
            allComplete(item.waitsOnBoard.map(onBoard)),
        };
      });
    }),
  );
  if ("error" in created) return created;
  for (const row of created) {
    await deps.onTicketChange?.({
      spaceId: scope.spaceId,
      boardId: board.id,
      ticketId: row.id,
      assigneeBotId: row.assigneeBotId,
      wakeAssignee: row.ready && row.assigneeBotId !== scope.botId,
    });
  }
  return {
    tickets: created.map((row, index) => {
      const item = plan.tickets[index];
      return {
        key: item?.key,
        id: row.id,
        ref: ticketRef(board.ticketPrefix, row.number),
        title: item?.title,
        ownerBotId: row.assigneeBotId,
        waitsOn: [
          ...(item?.waitsOnPlan ?? []).map((other) =>
            ticketRef(board.ticketPrefix, created[other]?.number ?? 0),
          ),
          ...(item?.waitsOnBoard ?? []),
        ],
      };
    }),
  };
}
