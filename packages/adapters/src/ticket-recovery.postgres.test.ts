import { randomUUID } from "node:crypto";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { ticketRecoverJobKey } from "@rakazo/adapter-kit";
import {
  coerceTicketRecovery,
  TICKET_RETRY_DELAYS_MS,
  TICKET_RETRY_WAKE_NOTE,
  TICKET_STEP_CONNECT_MODEL,
  userRunError,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  cancelRunsInTransaction,
  createDb,
  createPool,
  finalizeRun,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { failRunBeforeTurn } from "./run-lifecycle.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";
import { createTicketChangeNotifier } from "./ticket-changes.js";
import { retryStuckTicket, sweepStuckTickets } from "./ticket-recovery.js";
import { createTicket, updateTicket } from "./ticket-tools.js";
import { GraphileJobPublisher } from "./wakeup.js";

const url = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL ?? url;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

/** The error the scripted model runtime fails with for this prompt, as a run stores it. */
async function scriptedFailure(prompt: string): Promise<string> {
  const runtime = new ScriptedAgentRuntime();
  try {
    for await (const _event of runtime.run({
      runId: randomUUID(),
      prompt: `fail this run ${prompt}`,
    } as AgentRunRequest)) {
      // A failing script throws before its first event.
    }
  } catch (error) {
    return userRunError(error);
  }
  throw new Error("The scripted run did not fail.");
}

describePostgres("stuck ticket recovery (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Pool;
  let system: PrismaClient;
  let jobs: GraphileJobPublisher;
  let identity: { userId: string; spaceId: string; botId: string };
  const address = `ticket-recovery-${randomUUID()}@rakazo.test`;
  const alerts = vi.fn(async (_userId: string, _alert: unknown) => undefined);

  beforeAll(async () => {
    db = createDb(url!);
    owner = createPool(ownerUrl!);
    system = asSystem(db.prisma);
    jobs = new GraphileJobPublisher(db.pool);
    const provisioned = await runAsSystem("ticket recovery fixture", () =>
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
    await system.bot.update({ where: { id: identity.botId }, data: { notifyOnFinish: true } });
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

  const onTicketChange = () =>
    createTicketChangeNotifier({
      prisma: system,
      jobs: { enqueue: vi.fn(async () => {}) } as never,
      boardEvents: { notify: async () => {} } as never,
    });

  const deps = () =>
    ({
      prisma: system,
      jobs,
      onTicketChange: onTicketChange(),
      events: {
        finalizeRun: (input: Parameters<typeof finalizeRun>[1]) => finalizeRun(system, input),
        publishChatAlert: alerts,
      },
    }) as unknown as ExecutorDeps;

  async function recoverJob(ticketId: string) {
    const { rows } = await owner.query<{ run_at: Date }>(
      "select run_at from graphile_worker._private_jobs where key = $1",
      [ticketRecoverJobKey(ticketId)],
    );
    return rows[0] ?? null;
  }

  async function newTicket(title: string) {
    const created = await createTicket(
      { prisma: system, onTicketChange: onTicketChange() },
      {
        spaceId: identity.spaceId,
        userId: identity.userId,
        title,
        ownerBotId: identity.botId,
      },
    );
    if ("error" in created) throw new Error(created.error);
    // Its bot started on it.
    await system.ticket.update({ where: { id: created.ticket.id }, data: { status: "doing" } });
    return created.ticket.id;
  }

  /** Takes the ticket's queued run, the way a worker does. */
  async function startRun(ticketId: string) {
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
    return { run, attempt };
  }

  /** Fails the ticket's queued run with the scripted runtime's error, the way the executor does. */
  async function failRun(ticketId: string, error: string) {
    const { run, attempt } = await startRun(ticketId);
    const failed = await failRunBeforeTurn(
      deps(),
      { ...run, trigger: "tickets" },
      "Builder",
      { attemptId: attempt.id, workerId: "worker", fence: 1 },
      error,
    );
    expect(failed).toBe(true);
    return run.id;
  }

  const ticket = (ticketId: string) => system.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  const comments = async (ticketId: string) =>
    (
      await system.ticketComment.findMany({ where: { ticketId }, orderBy: { createdAt: "asc" } })
    ).map((comment) => comment.body);

  it("retries a provider outage on its schedule, then blocks", async () => {
    const ticketId = await newTicket("Ship the export");
    const overloaded = await scriptedFailure("overloaded");
    const delays = TICKET_RETRY_DELAYS_MS.provider;

    for (const [index, delay] of delays.entries()) {
      const before = Date.now();
      const runId = await failRun(ticketId, overloaded);
      expect(coerceTicketRecovery((await ticket(ticketId)).recovery)).toEqual({
        runId,
        kind: "provider",
        tries: { provider: index + 1 },
      });
      const job = await recoverJob(ticketId);
      expect(job?.run_at.getTime()).toBeGreaterThanOrEqual(before + delay - 1_000);
      expect(job?.run_at.getTime()).toBeLessThanOrEqual(Date.now() + delay + 1_000);

      // The job fires: the bot is woken to carry on, once.
      await expect(retryStuckTicket(deps(), ticketId)).resolves.toBe(true);
      await expect(retryStuckTicket(deps(), ticketId)).resolves.toBe(false);
      const wake = await system.task.findFirstOrThrow({
        where: { ticketId, runs: { some: { status: "queued" } } },
      });
      expect(wake.prompt).toContain(TICKET_RETRY_WAKE_NOTE);
    }

    await failRun(ticketId, overloaded);
    expect(await ticket(ticketId)).toMatchObject({ status: "blocked" });
    expect(await recoverJob(ticketId)).toBeNull();
    expect((await comments(ticketId)).at(-1)).toMatch(
      /^Blocked\. The provider was unavailable 3 times in a row\.\n/,
    );
    expect(await system.run.count({ where: { task: { ticketId }, status: "queued" } })).toBe(0);
    // Nothing is left for the sweep.
    await sweepStuckTickets(deps());
    expect(await ticket(ticketId)).toMatchObject({ status: "blocked" });

    // A person moving it back starts its recovery over: the sweep wakes its bot again.
    const moved = await updateTicket(
      { prisma: system, onTicketChange: onTicketChange() },
      { spaceId: identity.spaceId, userId: identity.userId, id: ticketId, status: "doing" },
    );
    expect(moved).toHaveProperty("ticket.status", "doing");
    expect(coerceTicketRecovery((await ticket(ticketId)).recovery)).toMatchObject({ tries: {} });
    await sweepStuckTickets(deps());
    expect(coerceTicketRecovery((await ticket(ticketId)).recovery)).toMatchObject({
      kind: "cut_off",
      tries: { cut_off: 1 },
    });
    expect(await recoverJob(ticketId)).not.toBeNull();
  });

  it("asks a person once when only they can fix it", async () => {
    const ticketId = await newTicket("Write the guide");
    alerts.mockClear();
    await failRun(ticketId, await scriptedFailure("rejected key"));
    expect(await ticket(ticketId)).toMatchObject({ status: "blocked" });
    expect(await recoverJob(ticketId)).toBeNull();
    expect((await comments(ticketId)).at(-1)).toMatch(
      new RegExp(`^Needs you: ${TICKET_STEP_CONNECT_MODEL}`),
    );
    // Wait for the fire-and-forget alert.
    await vi.waitFor(() =>
      expect(alerts).toHaveBeenCalledWith(
        identity.userId,
        expect.objectContaining({
          kind: "help",
          body: expect.stringContaining(TICKET_STEP_CONNECT_MODEL),
        }),
      ),
    );
    expect(alerts).toHaveBeenCalledTimes(1);
  });

  it("blocks an unknown failure without retrying it", async () => {
    const ticketId = await newTicket("Tidy the backlog");
    await failRun(ticketId, await scriptedFailure("plainly"));
    expect(await ticket(ticketId)).toMatchObject({ status: "blocked" });
    expect((await comments(ticketId)).at(-1)).toBe(
      "Blocked. The run failed.\nThe model provider returned an error.",
    );
  });

  it("never retries a person's stop, and sweeps up work that ended with the ticket open", async () => {
    const stopped = await newTicket("Stopped by a person");
    const { run } = await startRun(stopped);
    await system.$transaction((tx) => cancelRunsInTransaction(tx, [run], new Date()));

    const finished = await newTicket("Left in progress");
    const { run: done, attempt } = await startRun(finished);
    await finalizeRun(system, {
      spaceId: done.spaceId,
      threadId: done.threadId,
      botId: done.botId,
      runId: done.id,
      taskId: done.taskId,
      attemptId: attempt.id,
      leaseOwner: "worker",
      leaseFence: 1,
      outcome: "completed",
      blocks: [],
    });

    await sweepStuckTickets(deps());
    expect((await ticket(stopped)).recovery).toBeNull();
    expect(await recoverJob(stopped)).toBeNull();
    expect(coerceTicketRecovery((await ticket(finished)).recovery)).toEqual({
      runId: done.id,
      kind: "cut_off",
      tries: { cut_off: 1 },
    });
    const job = await recoverJob(finished);
    expect(job).not.toBeNull();
    // A second pass finds it already handled.
    await sweepStuckTickets(deps());
    expect((await recoverJob(finished))?.run_at).toEqual(job?.run_at);
    expect(coerceTicketRecovery((await ticket(finished)).recovery)?.tries).toEqual({ cut_off: 1 });
  });
});
