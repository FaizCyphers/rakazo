import { randomUUID } from "node:crypto";
import type { AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { ticketVerifyJobKey } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createPool,
  finalizeRun,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTicketChangeNotifier } from "./ticket-changes.js";
import { createTicket, updateTicket } from "./ticket-tools.js";
import type { TicketVerifyRequest } from "./ticket-verify.js";
import {
  recordTicketVerification,
  runTicketVerifyJudge,
  verifyTicketRun,
} from "./ticket-verify.js";
import { GraphileJobPublisher } from "./wakeup.js";

const url = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL ?? url;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

/** A judge model that answers from a script, one reply per call. */
function scriptedJudge(replies: string[]) {
  const runtime = {
    describe: () => ({
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: {},
    }),
    async *run(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "done", text: replies.shift() ?? "" } as AgentRuntimeEvent;
    },
  } as unknown as AgentRuntime;
  const requests: TicketVerifyRequest[] = [];
  return {
    requests,
    judge: (request: TicketVerifyRequest) => {
      requests.push(request);
      return runTicketVerifyJudge({
        runtime,
        model: { provider: "scripted", id: "judge" },
        request,
      });
    },
  };
}

describePostgres("ticket verification (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Pool;
  let system: PrismaClient;
  let jobs: GraphileJobPublisher;
  let identity: { userId: string; spaceId: string; botId: string };
  const address = `ticket-verify-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    owner = createPool(ownerUrl!);
    system = asSystem(db.prisma);
    jobs = new GraphileJobPublisher(db.pool);
    const provisioned = await runAsSystem("ticket verify fixture", () =>
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
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.space.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await jobs?.close();
    await owner?.end();
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  const ticketDeps = () => ({
    prisma: system,
    onTicketChange: createTicketChangeNotifier({
      prisma: system,
      jobs: { enqueue: vi.fn(async () => {}) } as never,
      boardEvents: { notify: async () => {} } as never,
    }),
  });

  async function jobExists(key: string): Promise<boolean> {
    const { rows } = await owner.query(
      "select 1 from graphile_worker._private_jobs where key = $1",
      [key],
    );
    return rows.length > 0;
  }

  /** Finishes the newest queued ticket run as completed, the way the executor does. */
  async function finishRun(ticketId: string, reply: string) {
    const run = await system.run.findFirstOrThrow({
      where: { task: { ticketId }, status: "queued" },
      orderBy: { createdAt: "desc" },
    });
    await system.run.update({
      where: { id: run.id },
      data: { status: "running", leaseOwner: "worker", leaseFence: 1, startedAt: new Date() },
    });
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    let recorded: string | null = null;
    const finished = await finalizeRun(system, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      taskId: run.taskId,
      attemptId: attempt.id,
      leaseOwner: "worker",
      leaseFence: 1,
      outcome: "completed",
      blocks: [],
      onCompleted: async (tx) => {
        recorded = await recordTicketVerification(tx, jobs, {
          runId: run.id,
          taskId: run.taskId,
          reply,
        });
      },
    });
    expect(finished).not.toBe(false);
    expect(recorded).toBe(ticketId);
    return run.id;
  }

  const fail =
    '{"steps":[{"pass":true,"reason":"Tests linked"},{"pass":false,"reason":"No docs change shown"}],"verdict":"fail"}';
  const pass =
    '{"steps":[{"pass":true,"reason":"Tests linked"},{"pass":true,"reason":"Docs PR linked"}],"verdict":"pass"}';

  it("checks each finished run, retries once, and waits for sign-off", async () => {
    const created = await createTicket(ticketDeps(), {
      spaceId: identity.spaceId,
      userId: identity.userId,
      title: "Ship the export",
      ownerBotId: identity.botId,
      acceptance: [{ text: "Tests pass" }, { text: "Docs updated" }],
    });
    if ("error" in created) throw new Error(created.error);
    const ticketId = created.ticket.id;
    await system.board.updateMany({
      where: { spaceId: identity.spaceId },
      data: { requireSignOff: true },
    });
    const judge = scriptedJudge([fail, pass]);
    const deps = {
      prisma: system,
      jobs,
      verifier: { judge: judge.judge },
      onTicketChange: ticketDeps().onTicketChange,
    };

    const first = await finishRun(ticketId, "Verification\n- Tests pass: PASS (CI green)");
    expect(await jobExists(ticketVerifyJobKey(ticketId, first))).toBe(true);
    await expect(verifyTicketRun(deps, first)).resolves.toBe("retry");
    expect(await jobExists(ticketVerifyJobKey(ticketId, first))).toBe(false);
    expect(judge.requests[0]?.reply).toContain("Tests pass: PASS");
    // A repeat, such as the backup job firing late, finds nothing to do.
    await expect(verifyTicketRun(deps, first)).resolves.toBeNull();

    const retry = await system.task.findFirstOrThrow({
      where: { ticketId, runs: { some: { status: "queued" } } },
    });
    expect(retry.prompt).toContain("Docs updated: No docs change shown");

    const second = await finishRun(ticketId, "Verification\n- Docs updated: PASS (docs PR)");
    await expect(verifyTicketRun(deps, second)).resolves.toBe("passed");
    const checked = await system.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(checked).toMatchObject({
      status: "review",
      verifyFailures: null,
      acceptance: [
        { text: "Tests pass", checked: true },
        { text: "Docs updated", checked: true },
      ],
      verification: expect.objectContaining({ verdict: "pass", runId: second }),
    });
    const comments = await system.ticketComment.findMany({
      where: { ticketId },
      orderBy: { createdAt: "asc" },
    });
    expect(comments.map((comment) => comment.body.split("\n")[0])).toEqual([
      "Checked: not done yet.",
      "Checked: every step passed.",
    ]);

    // Only a person signs off.
    const scope = { spaceId: identity.spaceId, userId: identity.userId, id: ticketId };
    await expect(
      updateTicket(ticketDeps(), { ...scope, botId: identity.botId, status: "done" }),
    ).resolves.toHaveProperty("error");
    await expect(updateTicket(ticketDeps(), { ...scope, status: "done" })).resolves.toHaveProperty(
      "ticket.status",
      "done",
    );
  });

  it("blocks a ticket whose work fails twice", async () => {
    await system.board.updateMany({
      where: { spaceId: identity.spaceId },
      data: { requireSignOff: null },
    });
    const created = await createTicket(ticketDeps(), {
      spaceId: identity.spaceId,
      userId: identity.userId,
      title: "Write the guide",
      ownerBotId: identity.botId,
      acceptance: [{ text: "Tests pass" }, { text: "Docs updated" }],
    });
    if ("error" in created) throw new Error(created.error);
    const ticketId = created.ticket.id;
    const deps = {
      prisma: system,
      jobs,
      verifier: scriptedJudge([fail, "not json"]),
      onTicketChange: ticketDeps().onTicketChange,
    };
    await expect(verifyTicketRun(deps, await finishRun(ticketId, "Done."))).resolves.toBe("retry");
    await expect(verifyTicketRun(deps, await finishRun(ticketId, "Done."))).resolves.toBe(
      "blocked",
    );
    await expect(
      system.ticket.findUniqueOrThrow({ where: { id: ticketId } }),
    ).resolves.toMatchObject({
      status: "blocked",
      verification: expect.objectContaining({ verdict: "unverified" }),
    });
    // Nothing more is queued for the bot.
    expect(await system.run.count({ where: { task: { ticketId }, status: "queued" } })).toBe(0);
  });
});
