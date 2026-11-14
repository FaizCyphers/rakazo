import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTicketChangeNotifier } from "./ticket-changes.js";
import { createTicketPlan, getTicket, prepareTicketPlan, updateTicket } from "./ticket-tools.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("ticket plans (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string };
  let plannerId: string;
  const address = `ticket-plan-${randomUUID()}@rakazo.test`;
  const enqueue = vi.fn(async () => {});

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("ticket plan fixture", () =>
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
    await system.user.update({ where: { id: identity.userId }, data: { labs: ["board"] } });
    const planner = await system.bot.create({
      data: { spaceId: identity.spaceId, userId: identity.userId, name: "Planner", color: "#000" },
    });
    plannerId = planner.id;
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.space.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  function deps() {
    return {
      prisma: system,
      onTicketChange: createTicketChangeNotifier({
        prisma: system,
        jobs: { enqueue } as never,
        boardEvents: { notify: async () => {} } as never,
      }),
    };
  }
  const scope = () => ({ spaceId: identity.spaceId, userId: identity.userId, botId: plannerId });
  /** Refs the owner bot was woken for, in order. */
  async function woken(): Promise<string[]> {
    const tasks = await system.task.findMany({
      where: { botId: identity.botId, runs: { some: { trigger: "tickets" } } },
      orderBy: { createdAt: "asc" },
      select: { prompt: true },
    });
    return tasks.map((task) => /ticket (\S+?)\./.exec(task.prompt)?.[1] ?? "");
  }

  it("creates a plan in one go and starts each ticket once its prerequisites are done", async () => {
    const owner = identity.botId;
    const prepared = await prepareTicketPlan(deps(), scope(), {
      tickets: [
        { key: "api", title: "API", ownerBotId: owner, doneWhen: "Endpoints merged" },
        { key: "ui", title: "UI", ownerBotId: owner, waitsOn: ["api"] },
        {
          key: "docs",
          title: "Docs",
          ownerBotId: owner,
          waitsOn: ["api", "ui"],
          acceptance: [{ text: "Linked from the README" }],
        },
      ],
    });
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.summary.lines[2]).toMatch(/^3\. Docs — .+ · waits on #1, #2$/);

    const created = await createTicketPlan(deps(), scope(), prepared.canonical);
    if ("error" in created) throw new Error(created.error);
    const [api, ui, docs] = created.tickets;
    expect(docs?.waitsOn).toEqual([api?.ref, ui?.ref]);
    expect(await system.ticketDependency.count({ where: { spaceId: identity.spaceId } })).toBe(3);
    expect(await woken()).toEqual([api?.ref]);

    const read = await getTicket(deps(), { spaceId: identity.spaceId, ref: docs!.ref });
    expect(read).toHaveProperty("ticket.waitsOn", [api?.ref, ui?.ref]);
    expect(read).toHaveProperty("ticket.acceptance", [
      { text: "Linked from the README", checked: false },
    ]);

    // A cycle through existing links is refused.
    await expect(
      updateTicket(deps(), {
        spaceId: identity.spaceId,
        userId: identity.userId,
        id: api!.id,
        waitsOn: [docs!.ref],
      }),
    ).resolves.toEqual({ error: "waitsOn would make tickets wait on each other." });

    const done = (id: string, status = "done") =>
      updateTicket(deps(), { spaceId: identity.spaceId, userId: identity.userId, id, status });
    await done(api!.id);
    expect(await woken()).toEqual([api?.ref, ui?.ref]);
    await done(ui!.id);
    expect(await woken()).toEqual([api?.ref, ui?.ref, docs?.ref]);
    // Closing an already finished ticket starts nothing again.
    await done(ui!.id, "closed");
    expect(await woken()).toHaveLength(3);

    // Deleting a ticket removes its links.
    await system.ticket.delete({ where: { id: api!.id } });
    expect(await system.ticketDependency.count({ where: { spaceId: identity.spaceId } })).toBe(1);
  });

  it("wakes a ticket once when its last two prerequisites finish at the same time", async () => {
    const owner = identity.botId;
    const created = await createTicketPlan(deps(), scope(), {
      tickets: [
        { key: "x", title: "X", ownerBotId: plannerId },
        { key: "y", title: "Y", ownerBotId: plannerId },
        { key: "z", title: "Z", ownerBotId: owner, waitsOn: ["x", "y"] },
      ],
    });
    if ("error" in created) throw new Error(created.error);
    const [x, y, z] = created.tickets;
    const before = await woken();
    await Promise.all(
      [x, y].map((ticket) =>
        updateTicket(deps(), {
          spaceId: identity.spaceId,
          userId: identity.userId,
          id: ticket!.id,
          status: "done",
        }),
      ),
    );
    expect((await woken()).slice(before.length)).toEqual([z?.ref]);
  });

  it("refuses a prerequisite that is not on this board", async () => {
    await expect(
      createTicketPlan(deps(), scope(), {
        tickets: [{ key: "a", title: "A", waitsOn: ["RAK-999999"] }],
      }),
    ).resolves.toEqual({ error: "Unknown ticket RAK-999999 in waitsOn." });
  });
});
