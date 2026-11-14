import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  finalizeRun,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { messageBot } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { sweepStuckTickets } from "./ticket-recovery.js";
import { createTicket } from "./ticket-tools.js";
import { markTicketStarted } from "./ticket-wake.js";
import { GraphileJobPublisher } from "./wakeup.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("delegations tracked on the board (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let jobs: GraphileJobPublisher;
  let identity: { userId: string; spaceId: string; botId: string };
  let builder: { id: string; name: string; threadId: string };
  const address = `delegation-tickets-${randomUUID()}@rakazo.test`;
  const onTicketChange = vi.fn(async (_change: unknown) => undefined);

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    jobs = new GraphileJobPublisher(db.pool);
    const provisioned = await runAsSystem("delegation tickets fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    identity = {
      userId: provisioned.userId,
      spaceId: provisioned.spaceId,
      botId: provisioned.botId,
    };
    const bot = await system.bot.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        name: "Builder",
        color: "ink",
        thread: { create: { spaceId: identity.spaceId, userId: identity.userId } },
      },
      include: { thread: true },
    });
    builder = { id: bot.id, name: bot.name, threadId: bot.thread!.id };
  });

  beforeEach(async () => {
    onTicketChange.mockClear();
    await system.user.update({ where: { id: identity.userId }, data: { labs: ["board"] } });
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.space.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await jobs?.close();
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  const deps = () =>
    ({
      prisma: system,
      jobs,
      onTicketChange,
      events: {
        notify: async () => undefined,
        finalizeRun: (input: Parameters<typeof finalizeRun>[1]) => finalizeRun(system, input),
      },
    }) as unknown as ExecutorDeps;

  /** A running turn of the chief bot, which delegates. */
  async function chiefRun() {
    const thread = await system.thread.findFirstOrThrow({ where: { botId: identity.botId } });
    const task = await system.task.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        threadId: thread.id,
        prompt: "Plan the release",
        status: "running",
      },
    });
    return system.run.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
  }

  async function send(message: string, intent?: "request" | "fyi") {
    const run = await chiefRun();
    const sent = await messageBot(
      deps(),
      run,
      { id: identity.botId, name: "Chief" },
      { bot_id: builder.id, message, intent, deliveryKey: randomUUID() },
    );
    if (!sent.ok) throw new Error(sent.error);
    const delivered = await system.run.findFirstOrThrow({
      where: { botId: builder.id, threadId: builder.threadId },
      orderBy: { createdAt: "desc" },
      include: { task: true, sourceMessage: true },
    });
    return { sent, delivered };
  }

  const board = () => system.board.findUniqueOrThrow({ where: { spaceId: identity.spaceId } });

  it("tracks a request as a ticket its delivered run works", async () => {
    const { sent, delivered } = await send("Draft the release notes\n\nCover every change.");
    const ticket = await system.ticket.findUniqueOrThrow({
      where: { id: delivered.task.ticketId! },
    });
    const ref = `${(await board()).ticketPrefix}-${ticket.number}`;
    expect(ticket).toMatchObject({
      title: "Draft the release notes",
      description: "Draft the release notes\n\nCover every change.",
      status: "doing",
      assigneeBotId: builder.id,
      createdByBotId: identity.botId,
    });
    expect(sent).toMatchObject({
      ticket: ref,
      note: expect.stringMatching(`^Tracked as ${ref}\\.`),
    });
    const block = (delivered.sourceMessage!.blocks as MessageBlock[])[0];
    expect(block).toMatchObject({
      kind: "bot_message_received",
      text: expect.stringMatching(`^Tracked as ${ref}\\. .*\\n\\nDraft the release notes`),
    });
    expect(delivered.task.prompt).toContain(`Tracked as ${ref}.`);
    // Shown on the board; the delivered run is its work, so nothing else is woken.
    expect(onTicketChange).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: ticket.id, wakeAssignee: false }),
    );
    expect(await system.task.count({ where: { ticketId: ticket.id } })).toBe(1);
  });

  it("links a request that names the target's open ticket", async () => {
    const created = await createTicket(
      { prisma: system },
      {
        spaceId: identity.spaceId,
        userId: identity.userId,
        title: "Fix the flaky test",
        ownerBotId: builder.id,
      },
    );
    if ("error" in created) throw new Error(created.error);
    const before = await system.ticket.count({ where: { spaceId: identity.spaceId } });
    const { sent, delivered } = await send(`Please take ${created.ticket.ref} today.`);
    expect(sent).toMatchObject({ ticket: created.ticket.ref });
    expect(delivered.task.ticketId).toBe(created.ticket.id);
    expect(await system.ticket.count({ where: { spaceId: identity.spaceId } })).toBe(before);

    // Its run starting moves it from To do to In progress, once.
    await markTicketStarted(deps(), delivered.id);
    await markTicketStarted(deps(), delivered.id);
    expect(
      await system.ticket.findUniqueOrThrow({ where: { id: created.ticket.id } }),
    ).toMatchObject({ status: "doing", recovery: null });
    expect(onTicketChange).toHaveBeenCalledTimes(2);
  });

  it("tracks nothing for an FYI, or without the board lab", async () => {
    const before = await system.ticket.count({ where: { spaceId: identity.spaceId } });
    const fyi = await send("FYI: the build is green.", "fyi");
    expect(fyi.sent).not.toHaveProperty("ticket");
    expect(fyi.delivered.task.ticketId).toBeNull();

    await system.user.update({ where: { id: identity.userId }, data: { labs: [] } });
    const off = await send("Draft the changelog");
    expect(off.sent).not.toHaveProperty("ticket");
    expect(off.delivered.task.ticketId).toBeNull();
    expect((off.delivered.sourceMessage!.blocks as MessageBlock[])[0]).toMatchObject({
      text: "Draft the changelog",
    });
    expect(await system.ticket.count({ where: { spaceId: identity.spaceId } })).toBe(before);
  });

  it("leaves a delegated ticket to its bot once the delivered run completes", async () => {
    const { delivered } = await send("Write the upgrade guide");
    const ticketId = delivered.task.ticketId!;
    await system.run.update({
      where: { id: delivered.id },
      data: { status: "running", leaseOwner: "worker", leaseFence: 1, startedAt: new Date() },
    });
    // Live: the sweep leaves it alone.
    await sweepStuckTickets(deps());
    expect(
      (await system.ticket.findUniqueOrThrow({ where: { id: ticketId } })).recovery,
    ).toBeNull();

    const attempt = await system.attempt.create({
      data: { runId: delivered.id, fence: 1, status: "running" },
    });
    await finalizeRun(system, {
      spaceId: delivered.spaceId,
      threadId: delivered.threadId,
      botId: delivered.botId,
      runId: delivered.id,
      taskId: delivered.taskId,
      attemptId: attempt.id,
      leaseOwner: "worker",
      leaseFence: 1,
      outcome: "completed",
      blocks: [],
    });
    await sweepStuckTickets(deps());
    expect(await system.ticket.findUniqueOrThrow({ where: { id: ticketId } })).toMatchObject({
      status: "doing",
      recovery: null,
    });
  });

  it("tracks a handoff as a ticket its handed-off run works", async () => {
    const group = await system.chatGroup.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        name: "Release",
        members: { create: [{ botId: identity.botId }, { botId: builder.id }] },
        thread: { create: { spaceId: identity.spaceId, userId: identity.userId } },
      },
      include: { thread: true },
    });
    const run = await chiefRun();
    const result = await handoffToGroupBot(deps(), run, group.id, {
      bot_id: builder.id,
      message: "Package the release",
      deliveryKey: randomUUID(),
    });
    if (!("ok" in result)) throw new Error(result.error);
    const handed = await system.run.findUniqueOrThrow({
      where: { id: result.runId },
      include: { task: true },
    });
    const ticket = await system.ticket.findUniqueOrThrow({ where: { id: handed.task.ticketId! } });
    const ref = `${(await board()).ticketPrefix}-${ticket.number}`;
    expect(ticket).toMatchObject({
      title: "Package the release",
      status: "doing",
      assigneeBotId: builder.id,
    });
    expect(handed.threadId).toBe(group.thread!.id);
    expect(handed.task.prompt.startsWith(`Tracked as ${ref}.`)).toBe(true);
    expect(result).toMatchObject({
      ticket: ref,
      note: expect.stringMatching(`^Tracked as ${ref}\\.`),
    });
  });
});
