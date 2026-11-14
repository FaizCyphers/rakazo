import {
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import { TICKET_WAITS_ON_INCLUDE } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  commentTicket,
  createTicket,
  createTicketPlan,
  getTicket,
  listBoardTickets,
  prepareTicketPlan,
  TICKET_CHECKED_ON_FINISH,
  updateTicket,
} from "./ticket-tools.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function board(overrides: Record<string, unknown> = {}) {
  return {
    id: "board-1",
    spaceId: "ws",
    name: "Personal",
    ticketPrefix: "RAK",
    nextNumber: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function boardSpace() {
  const row = board();
  return {
    board: {
      findUnique: vi.fn(async () => row),
      createMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
    space: { findUnique: vi.fn(async () => ({ name: "Personal" })) },
  };
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    boardId: "board-1",
    spaceId: "ws",
    number: 1,
    title: "Ticket",
    description: null,
    status: "todo",
    priority: null,
    assigneeBotId: "bot-1",
    createdByBotId: null,
    createdByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

describe("ticket tools", () => {
  it("lists tickets strictly within the space and board", async () => {
    const findMany = vi.fn(async () => [ticket({ number: 1, status: "doing" })]);
    const prisma = {
      ...boardSpace(),
      ticket: { findMany },
    };

    const result = await listBoardTickets({ prisma } as never, {
      spaceId: "ws",
      status: "doing",
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "ws", boardId: "board-1", status: "doing" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    expect(result).toEqual({ tickets: [expect.objectContaining({ ref: "RAK-1" })] });
  });

  it("leaves closed tickets out of an unfiltered list and shortens descriptions", async () => {
    const findMany = vi.fn(async () => [ticket({ number: 2, description: "x".repeat(500) })]);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const result = await listBoardTickets({ prisma } as never, {
      spaceId: "ws",
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws", boardId: "board-1", status: { not: "closed" } },
        take: 51,
      }),
    );
    const listed = (result as { tickets: { description: string }[] }).tickets[0]!;
    expect(listed.description).toHaveLength(200);
    expect(listed.description.endsWith("…")).toBe(true);
  });

  it("does not split an emoji when it shortens a description", async () => {
    const description = `${"x".repeat(198)}😀tail`;
    const findMany = vi.fn(async () => [ticket({ number: 2, description })]);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const result = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
    });

    const listed = (result as { tickets: { description: string }[] }).tickets[0]!;
    expect(listed.description).toBe(`${"x".repeat(198)}…`);
  });

  it("pages older tickets with a cursor and rejects a bad one", async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      ticket({
        id: `t${String(index).padStart(2, "0")}`,
        number: index + 1,
        createdAt: new Date(NOW.getTime() - index * 1000),
      }),
    );
    const findMany = vi.fn(async (_query: unknown) => rows);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const first = await listBoardTickets({ prisma } as never, {
      spaceId: "ws",
    });
    expect(first).toEqual({
      tickets: expect.any(Array),
      nextCursor: expect.any(String),
    });
    const page = first as { tickets: { id: string }[]; nextCursor: string };
    expect(page.tickets).toHaveLength(50);
    expect(page.tickets[49]?.id).toBe("t49");

    await listBoardTickets({ prisma } as never, {
      spaceId: "ws",
      cursor: page.nextCursor,
    });
    expect(findMany.mock.calls[1]?.[0]).toEqual({
      where: {
        spaceId: "ws",
        boardId: "board-1",
        status: { not: "closed" },
        OR: [
          { createdAt: { lt: rows[49]!.createdAt } },
          { createdAt: rows[49]!.createdAt, id: { lt: "t49" } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });

    const invalid = await listBoardTickets({ prisma } as never, {
      spaceId: "ws",
      cursor: "not-a-cursor",
    });
    expect(invalid).toEqual({ error: "cursor is invalid." });
  });
});

function mutationDeps() {
  let current = ticket();
  const changes = vi.fn(async (_change: { wakeAssignee: boolean }) => {});
  const tx = {
    board: { update: vi.fn(async () => ({ nextNumber: 2 })) },
    ticket: {
      findFirst: vi.fn(async () => current),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        // The row comes back with its links as numbers, not the nested create.
        const { waitsOn: _waitsOn, ...fields } = data;
        current = ticket(fields);
        return current;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...current, ...data };
        return current;
      }),
    },
    ticketComment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "comment-1",
        createdAt: NOW,
        updatedAt: NOW,
        authorBot: { name: "Planner" },
        authorUser: null,
        ...data,
      })),
    },
    $queryRaw: vi.fn(async () => []),
  };
  const prisma = {
    ...boardSpace(),
    bot: { findFirst: vi.fn(async () => ({ id: "bot-2" })) },
    ticket: tx.ticket,
    ticketComment: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    deps: { prisma, onTicketChange: changes } as never,
    prisma,
    tx,
    changes,
  };
}

describe("ticket mutations", () => {
  it.each([
    ["create", "title", TICKET_TITLE_MAX_LENGTH],
    ["create", "description", TICKET_DESCRIPTION_MAX_LENGTH],
    ["update", "title", TICKET_TITLE_MAX_LENGTH],
    ["update", "description", TICKET_DESCRIPTION_MAX_LENGTH],
    ["comment", "body", TICKET_COMMENT_MAX_LENGTH],
  ] as const)(
    "explains an oversized %s %s before database access",
    async (operation, field, limit) => {
      const s = mutationDeps();
      const value = "x".repeat(limit + 1);
      const input = { spaceId: "ws", userId: "user-1", botId: "bot-1", id: "t1" };
      const result =
        operation === "create"
          ? await createTicket(s.deps, { ...input, title: "Ship", [field]: value })
          : operation === "update"
            ? await updateTicket(s.deps, { ...input, [field]: value })
            : await commentTicket(s.deps, { ...input, body: value });

      expect(result).toHaveProperty("error", expect.stringContaining(field));
      expect(result).toHaveProperty("error", expect.stringContaining(String(limit)));
      expect(result).toHaveProperty("error", expect.not.stringContaining(value));
      expect(s.prisma.board.findUnique).not.toHaveBeenCalled();
      expect(s.prisma.bot.findFirst).not.toHaveBeenCalled();
      expect(s.prisma.$transaction).not.toHaveBeenCalled();
      expect(s.changes).not.toHaveBeenCalled();
    },
  );

  it("preserves complete values at the existing length limits", async () => {
    const s = mutationDeps();
    const title = "x".repeat(TICKET_TITLE_MAX_LENGTH);
    const description = "x".repeat(TICKET_DESCRIPTION_MAX_LENGTH);
    const body = "x".repeat(TICKET_COMMENT_MAX_LENGTH);
    const input = { spaceId: "ws", userId: "user-1", botId: "bot-1", id: "t1" };

    await expect(
      createTicket(s.deps, { ...input, title: ` ${title} `, description }),
    ).resolves.toHaveProperty("ticket.title", title);
    expect(s.tx.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title, description }) }),
    );
    await expect(
      updateTicket(s.deps, { ...input, title: ` ${title} `, description }),
    ).resolves.toHaveProperty("ticket.description", description);
    expect(s.tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title, description }) }),
    );
    await expect(commentTicket(s.deps, { ...input, body: ` ${body} ` })).resolves.toHaveProperty(
      "comment.body",
      body,
    );
    expect(s.tx.ticketComment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ body }) }),
    );
  });

  it.each([
    ["title", " "],
    ["priority", "invalid-marker"],
    ["status", "invalid-marker"],
  ])("keeps invalid %s updates rejected with field-level feedback", async (field, value) => {
    const s = mutationDeps();
    const result = await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      id: "t1",
      [field]: value,
    });
    expect(result).toHaveProperty("error", expect.stringContaining(field));
    expect(result).toHaveProperty("error", expect.not.stringContaining("invalid-marker"));
    expect(s.prisma.board.findUnique).not.toHaveBeenCalled();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });

  it("uses public parameter names and keeps blank comments rejected", async () => {
    const s = mutationDeps();
    await expect(
      createTicket(s.deps, { spaceId: "ws", userId: "user-1", title: "Ship" }),
    ).resolves.toHaveProperty("error", expect.stringContaining("ownerBotId"));
    const result = await commentTicket(s.deps, { spaceId: "ws", id: "", body: " " });
    expect(result).toHaveProperty("error", expect.stringContaining("id:"));
    expect(result).toHaveProperty("error", expect.stringContaining("body:"));
    expect(result).toHaveProperty("error", expect.not.stringContaining("ticketId"));
    expect(s.prisma.board.findUnique).not.toHaveBeenCalled();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });

  it("allocates a number and wakes the assigned bot once", async () => {
    const s = mutationDeps();
    const result = await createTicket(s.deps, {
      spaceId: "ws",
      botId: "bot-1",
      userId: "user-1",
      title: "  Ship  ",
      ownerBotId: "bot-2",
    });
    expect(result).toEqual({
      ticket: expect.objectContaining({ ref: "RAK-1", title: "Ship", assigneeBotId: "bot-2" }),
    });
    expect(s.tx.board.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nextNumber: { increment: 1 } } }),
    );
    expect(s.changes).toHaveBeenCalledOnce();
    expect(s.changes).toHaveBeenCalledWith(expect.objectContaining({ wakeAssignee: true }));
  });
  it("wakes on an actual reassignment once, and never on status edits or repeated assignment", async () => {
    const s = mutationDeps();
    await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      id: "t1",
      ownerBotId: "bot-2",
      status: "doing",
    });
    expect(s.changes).toHaveBeenCalledWith(
      expect.objectContaining({ wakeAssignee: true, assigneeBotId: "bot-2" }),
    );
    await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      id: "t1",
      ownerBotId: "bot-2",
      status: "done",
    });
    expect(
      s.changes.mock.calls.map(([value]) => (value as { wakeAssignee: boolean }).wakeAssignee),
    ).toEqual([true, false]);
    expect(s.tx.ticket.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "done", completedAt: expect.any(Date) }),
      }),
    );
  });
  it("lets only a person finish a ticket when the board wants sign-off", async () => {
    const s = mutationDeps();
    const signOff = board({ requireSignOff: true });
    s.prisma.board.findUnique.mockResolvedValue(signOff);
    await s.tx.ticket.update({ data: { status: "review" } });
    s.tx.ticket.update.mockClear();

    const byBot = await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      botId: "bot-1",
      id: "t1",
      status: "done",
    });
    expect(byBot).toEqual({
      error:
        "This board needs a person's sign-off: move the ticket to review and they will move it to done.",
    });
    expect(s.tx.ticket.update).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();

    const byPerson = await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      id: "t1",
      status: "done",
    });
    expect(byPerson).toHaveProperty("ticket.status", "done");
    // Moving it themselves gives the work its checks again.
    expect(s.tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ verifyFailures: null }) }),
    );
  });

  it("leaves finishing a ticket with acceptance steps to the check", async () => {
    const s = mutationDeps();
    await s.tx.ticket.update({ data: { acceptance: [{ text: "Tests pass", checked: false }] } });
    s.tx.ticket.update.mockClear();
    const input = { spaceId: "ws", userId: "user-1", id: "t1", status: "done" };

    await expect(updateTicket(s.deps, { ...input, botId: "bot-1" })).resolves.toEqual({
      error: TICKET_CHECKED_ON_FINISH,
    });
    expect(s.tx.ticket.update).not.toHaveBeenCalled();
    // Done-when alone is checked too; a person can still finish it.
    await s.tx.ticket.update({ data: { acceptance: null, doneWhen: "Shipped" } });
    await expect(updateTicket(s.deps, { ...input, botId: "bot-1" })).resolves.toEqual({
      error: TICKET_CHECKED_ON_FINISH,
    });
    await expect(updateTicket(s.deps, input)).resolves.toHaveProperty("ticket.status", "done");
    // Without either, a bot finishes its ticket as before.
    await s.tx.ticket.update({ data: { doneWhen: null, status: "doing" } });
    await expect(updateTicket(s.deps, { ...input, botId: "bot-1" })).resolves.toHaveProperty(
      "ticket.status",
      "done",
    );
  });

  it("does not wake a bot creating or assigning a ticket to itself", async () => {
    const s = mutationDeps();
    await createTicket(s.deps, { spaceId: "ws", userId: "user-1", botId: "bot-1", title: "Ship" });
    await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      id: "t1",
      ownerBotId: "bot-2",
      botId: "bot-2",
    });
    expect(s.changes.mock.calls.map(([value]) => value.wakeAssignee)).toEqual([false, false]);
  });
  it("comments without waking the owner", async () => {
    const s = mutationDeps();
    const result = await commentTicket(s.deps, {
      spaceId: "ws",
      botId: "bot-1",
      id: "t1",
      body: " Ready ",
    });
    expect(result).toHaveProperty("comment.authorName", "Planner");
    expect(s.tx.ticketComment.create).toHaveBeenCalledWith({
      include: { authorBot: { select: { name: true } }, authorUser: { select: { name: true } } },
      data: expect.objectContaining({ body: "Ready", ticketId: "t1" }),
    });
    expect(s.changes).toHaveBeenCalledWith(expect.objectContaining({ wakeAssignee: false }));
  });
  it("reads tickets with their comments", async () => {
    const s = mutationDeps();
    await expect(getTicket(s.deps, { spaceId: "ws", ref: "RAK-1" })).resolves.toEqual({
      ticket: expect.objectContaining({ ref: "RAK-1" }),
      comments: [],
    });
    expect(s.prisma.ticket.findFirst).toHaveBeenCalledWith({
      where: { number: 1, spaceId: "ws", boardId: "board-1" },
      include: TICKET_WAITS_ON_INCLUDE,
    });
  });
  it("only assigns the acting user's own bots", async () => {
    const s = mutationDeps();
    s.prisma.bot.findFirst.mockResolvedValue(null as never);
    await expect(
      createTicket(s.deps, {
        spaceId: "ws",
        botId: "bot-1",
        userId: "user-1",
        title: "Ship",
        ownerBotId: "other-members-bot",
      }),
    ).resolves.toEqual({ error: "Unknown bot." });
    await expect(
      updateTicket(s.deps, {
        spaceId: "ws",
        userId: "user-1",
        id: "t1",
        ownerBotId: "other-members-bot",
      }),
    ).resolves.toEqual({ error: "Unknown bot." });
    for (const [query] of s.prisma.bot.findFirst.mock.calls as unknown as [unknown][]) {
      expect(query).toEqual({
        where: { id: "other-members-bot", spaceId: "ws", userId: "user-1", archivedAt: null },
        select: { id: true },
      });
    }
    expect(s.prisma.bot.findFirst).toHaveBeenCalledTimes(2);
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });
  it("rejects invalid input and foreign owners before a write", async () => {
    const s = mutationDeps();
    await expect(
      createTicket(s.deps, { spaceId: "ws", userId: "user-1", botId: "bot-1", title: " " }),
    ).resolves.toHaveProperty("error");
    s.prisma.bot.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      updateTicket(s.deps, { spaceId: "ws", userId: "user-1", id: "t1", ownerBotId: "foreign" }),
    ).resolves.toHaveProperty("error");
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });
});

/** Answers each raw query by what it reads, so a test only names what matters to it. */
function rawQueries(answers: {
  prerequisites?: unknown[];
  dependents?: unknown[];
  cycle?: unknown[];
}) {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("WITH RECURSIVE")) return answers.cycle ?? [];
    if (sql.includes("JOIN ticket_dependencies")) return answers.dependents ?? [];
    if (sql.includes("FOR SHARE")) return answers.prerequisites ?? [];
    return [];
  });
}

describe("ticket dependencies", () => {
  it("creates a ticket that waits on an unfinished one without waking its owner", async () => {
    const s = mutationDeps();
    Object.assign(s.tx, {
      $queryRaw: rawQueries({ prerequisites: [{ id: "t4", number: 4, status: "doing" }] }),
    });
    const result = await createTicket(s.deps, {
      spaceId: "ws",
      botId: "bot-1",
      userId: "user-1",
      title: "Ship",
      ownerBotId: "bot-2",
      doneWhen: "Deployed",
      acceptance: [{ text: "Smoke test passes" }],
      waitsOn: ["RAK-4"],
    });
    expect(result).toHaveProperty("ticket.title", "Ship");
    expect(s.tx.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          doneWhen: "Deployed",
          acceptance: [{ text: "Smoke test passes", checked: false }],
          waitsOn: { create: [{ dependsOnTicketId: "t4", spaceId: "ws" }] },
        }),
      }),
    );
    expect(s.changes).toHaveBeenCalledWith(expect.objectContaining({ wakeAssignee: false }));
  });

  it("refuses an unknown prerequisite and writes nothing", async () => {
    const s = mutationDeps();
    Object.assign(s.tx, { $queryRaw: rawQueries({ prerequisites: [] }) });
    await expect(
      createTicket(s.deps, {
        spaceId: "ws",
        userId: "user-1",
        botId: "bot-1",
        title: "Ship",
        waitsOn: ["RAK-9"],
      }),
    ).resolves.toEqual({ error: "Unknown ticket RAK-9 in waitsOn." });
    expect(s.tx.ticket.create).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });

  it("refuses waitsOn that would close a cycle", async () => {
    const s = mutationDeps();
    Object.assign(s.tx, {
      $queryRaw: rawQueries({
        prerequisites: [{ id: "t2", number: 2, status: "todo" }],
        cycle: [{ id: "t1" }],
      }),
      ticketDependency: { count: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    });
    await expect(
      updateTicket(s.deps, { spaceId: "ws", userId: "user-1", id: "t1", waitsOn: ["RAK-2"] }),
    ).resolves.toEqual({ error: "waitsOn would make tickets wait on each other." });
    expect(s.tx.ticket.update).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });

  it("wakes the owners of dependents whose prerequisites are now all complete", async () => {
    const s = mutationDeps();
    const count = vi.fn(async ({ where }: { where: { ticketId: string } }) =>
      where.ticketId === "t8" ? 1 : 0,
    );
    Object.assign(s.tx, {
      $queryRaw: rawQueries({
        dependents: [
          { id: "t7", assigneeBotId: "bot-3" },
          { id: "t8", assigneeBotId: "bot-4" },
        ],
      }),
      ticketDependency: { count },
    });
    await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      botId: "bot-1",
      id: "t1",
      status: "done",
    });
    expect(s.changes.mock.calls.map(([value]) => value)).toEqual([
      expect.objectContaining({ ticketId: "t1", wakeAssignee: false }),
      expect.objectContaining({ ticketId: "t7", assigneeBotId: "bot-3", wakeAssignee: true }),
    ]);

    // Already complete: moving from done to closed starts nothing new.
    s.changes.mockClear();
    await updateTicket(s.deps, { spaceId: "ws", userId: "user-1", id: "t1", status: "closed" });
    expect(s.changes).toHaveBeenCalledTimes(1);
  });
});

function planDeps(existing: Array<{ id: string; number: number; status: string }> = []) {
  const changes = vi.fn(async (_change: { ticketId: string; wakeAssignee: boolean }) => {});
  let next = 10;
  const tx = {
    board: { update: vi.fn(async () => ({ nextNumber: ++next })) },
    ticket: {
      create: vi.fn(async ({ data }: { data: { number: number; assigneeBotId: string } }) => ({
        id: `new-${data.number}`,
        number: data.number,
        assigneeBotId: data.assigneeBotId,
      })),
    },
    ticketDependency: { createMany: vi.fn(async (_args: unknown) => ({ count: 0 })) },
    $queryRaw: rawQueries({ prerequisites: existing }),
  };
  const prisma = {
    ...boardSpace(),
    bot: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [
          { id: "bot-1", name: "Planner" },
          { id: "bot-2", name: "Builder" },
        ].filter((bot) => where.id.in.includes(bot.id)),
      ),
    },
    ticket: {
      findMany: vi.fn(async ({ where }: { where: { number: { in: number[] } } }) =>
        existing.filter((row) => where.number.in.includes(row.number)),
      ),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { deps: { prisma, onTicketChange: changes } as never, prisma, tx, changes };
}

const scope = { spaceId: "ws", userId: "user-1", botId: "bot-1" };

describe("ticket plans", () => {
  it("shows every ticket, its owner and what it waits on before approval", async () => {
    const s = planDeps([{ id: "t4", number: 4, status: "done" }]);
    const prepared = await prepareTicketPlan(s.deps, scope, {
      tickets: [
        { key: "api", title: "Build the API", ownerBotId: "bot-2", waitsOn: ["rak-4"] },
        { key: "docs", title: "Write   the docs", waitsOn: ["API"] },
      ],
    });
    expect(prepared).toEqual({
      summary: {
        title: "Create 2 tickets?",
        lines: [
          "1. Build the API — Builder · waits on RAK-4",
          "2. Write the docs — Planner · waits on #1",
        ],
      },
      canonical: {
        tickets: [
          {
            key: "api",
            title: "Build the API",
            priority: "normal",
            ownerBotId: "bot-2",
            waitsOn: ["RAK-4"],
          },
          {
            key: "docs",
            title: "Write   the docs",
            priority: "normal",
            ownerBotId: "bot-1",
            waitsOn: ["api"],
          },
        ],
      },
    });
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a cycle",
      [
        { key: "a", title: "A", waitsOn: ["b"] },
        { key: "b", title: "B", waitsOn: ["c"] },
        { key: "c", title: "C", waitsOn: ["a"] },
      ],
      "These tickets wait on each other: a -> b -> c -> a.",
    ],
    ["a self wait", [{ key: "a", title: "A", waitsOn: ["A"] }], "a cannot wait on itself."],
    [
      "an unknown key",
      [{ key: "a", title: "A", waitsOn: ["nope"] }],
      "Unknown key or ticket nope in waitsOn of a.",
    ],
    [
      "an unknown board ticket",
      [{ key: "a", title: "A", waitsOn: ["RAK-77"] }],
      "Unknown ticket RAK-77 in waitsOn.",
    ],
    [
      "a duplicate key",
      [
        { key: "a", title: "A" },
        { key: "A", title: "B" },
      ],
      "tickets.1.key: Duplicate key A",
    ],
    [
      "an unknown owner",
      [{ key: "a", title: "A", ownerBotId: "other-members-bot" }],
      "Unknown bot other-members-bot.",
    ],
  ])("refuses %s before the card and writes nothing", async (_name, tickets, error) => {
    const s = planDeps();
    await expect(prepareTicketPlan(s.deps, scope, { tickets })).resolves.toEqual({ error });
    await expect(createTicketPlan(s.deps, scope, { tickets })).resolves.toEqual({ error });
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });

  it("refuses a plan too long to show whole on the card", async () => {
    const s = planDeps();
    const tickets = Array.from({ length: 20 }, (_, index) => ({
      key: `k${index}`,
      title: "x".repeat(TICKET_TITLE_MAX_LENGTH),
    }));
    await expect(prepareTicketPlan(s.deps, scope, { tickets })).resolves.toEqual({
      error: "This plan is too long to show on the approval card. Split it up.",
    });
  });

  it("writes every ticket and link in one transaction and wakes only the ready ones", async () => {
    const s = planDeps([
      { id: "t4", number: 4, status: "done" },
      { id: "t5", number: 5, status: "doing" },
    ]);
    const result = await createTicketPlan(s.deps, scope, {
      tickets: [
        { key: "a", title: "A", ownerBotId: "bot-2" },
        { key: "b", title: "B", ownerBotId: "bot-2", waitsOn: ["a"] },
        { key: "c", title: "C", ownerBotId: "bot-2", waitsOn: ["RAK-4"] },
        { key: "d", title: "D", ownerBotId: "bot-2", waitsOn: ["RAK-5"] },
        { key: "e", title: "E" },
      ],
    });
    expect(s.prisma.$transaction).toHaveBeenCalledOnce();
    expect(s.tx.ticket.create).toHaveBeenCalledTimes(5);
    expect(s.tx.ticketDependency.createMany).toHaveBeenCalledOnce();
    expect(s.tx.ticketDependency.createMany).toHaveBeenCalledWith({
      data: [
        { ticketId: "new-11", dependsOnTicketId: "new-10", spaceId: "ws" },
        { ticketId: "new-12", dependsOnTicketId: "t4", spaceId: "ws" },
        { ticketId: "new-13", dependsOnTicketId: "t5", spaceId: "ws" },
      ],
    });
    expect(s.changes.mock.calls.map(([value]) => [value.ticketId, value.wakeAssignee])).toEqual([
      ["new-10", true],
      ["new-11", false],
      ["new-12", true],
      ["new-13", false],
      // The planner owns E and is already running.
      ["new-14", false],
    ]);
    expect(result).toHaveProperty(
      "tickets.1",
      expect.objectContaining({ ref: "RAK-11", waitsOn: ["RAK-10"] }),
    );
  });

  it("wakes nobody when the transaction fails", async () => {
    const s = planDeps();
    s.tx.ticketDependency.createMany.mockRejectedValueOnce(new Error("conflict"));
    await expect(
      createTicketPlan(s.deps, scope, {
        tickets: [
          { key: "a", title: "A" },
          { key: "b", title: "B", waitsOn: ["a"] },
        ],
      }),
    ).rejects.toThrow("conflict");
    expect(s.changes).not.toHaveBeenCalled();
  });
});
