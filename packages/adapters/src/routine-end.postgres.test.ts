import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEvent,
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunExecutor } from "./executor.js";
import { finishRoutineFromRun } from "./routine-end.js";
import { updateScheduleFromTool } from "./schedule-tools.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("routines that end on their own (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-end-${randomUUID()}@rakazo.test`;
  const jobs = {
    enqueued: [] as { key?: string; runAt?: Date }[],
    cancelled: [] as string[],
    enqueue: async (job: { key?: string; runAt?: Date }) => {
      jobs.enqueued.push(job);
    },
    cancel: async (key: string) => {
      jobs.cancelled.push(key);
    },
    close: async () => undefined,
  };
  const deps = () =>
    ({
      prisma: system,
      jobs,
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    }) as unknown as Parameters<typeof finishRoutineFromRun>[0];
  const executor = () =>
    createRunExecutor(deps() as unknown as Parameters<typeof createRunExecutor>[0]);

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("routine end fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const { userId, spaceId, botId, threadId } = provisioned;
    identity = { userId, spaceId, botId, threadId };
  });
  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  const lastNote = async () => {
    const message = await system.message.findFirst({
      where: { threadId: identity.threadId, role: "system" },
      orderBy: { seq: "desc" },
      select: { blocks: true },
    });
    return JSON.stringify(message?.blocks ?? null);
  };

  const failedRun = async (routineId: string, createdAt = new Date()) => {
    const task = await system.task.create({
      data: { ...identity, prompt: "check", status: "failed" },
    });
    return system.run.create({
      data: {
        ...identity,
        taskId: task.id,
        status: "failed",
        trigger: "routine",
        routineId,
        createdAt,
      },
    });
  };

  it("holds the next firing at the end time, then ends there instead of running", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const endsAt = new Date(Date.now() + 60 * 60_000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "Deploy watch",
        prompt: "check the deploy",
        // New Year's only, so the next occurrence is always past the end time.
        crons: ["0 0 1 1 *"],
        active: true,
        nextRunAt: dueAt,
        endsAt,
      },
    });

    await executor().wakeRoutine(routine.id, dueAt.toISOString());
    const ran = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(ran).toMatchObject({ active: true, nextRunAt: endsAt });
    await expect(system.run.count({ where: { routineId: routine.id } })).resolves.toBe(1);

    // Move the end time, and the firing held there, into the past so that wake is due now.
    await system.routine.update({
      where: { id: routine.id },
      data: { endsAt: dueAt, nextRunAt: dueAt },
    });
    await executor().wakeRoutine(routine.id, dueAt.toISOString());
    const ended = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(ended).toMatchObject({ active: false, nextRunAt: null });
    expect(ended.endedAt).toBeInstanceOf(Date);
    await expect(system.run.count({ where: { routineId: routine.id } })).resolves.toBe(1);
    expect(await lastNote()).toContain("Deploy watch routine ended: end time reached");
  });

  it("ends after three failed runs in a row, counting only runs since it last ended", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "PR watch",
        prompt: "check the PR",
        crons: ["*/5 * * * *"],
        active: true,
        nextRunAt: dueAt,
        until: "the PR is merged",
      },
    });
    const before = new Date(Date.now() - 10 * 60_000);
    for (let i = 0; i < 3; i += 1) await failedRun(routine.id, before);
    // Turned back on after an earlier end: those failures no longer count.
    await system.routine.update({
      where: { id: routine.id },
      data: { endedAt: new Date(Date.now() - 5 * 60_000) },
    });
    await executor().wakeRoutine(routine.id, dueAt.toISOString());
    await expect(
      system.routine.findUniqueOrThrow({ where: { id: routine.id } }),
    ).resolves.toMatchObject({ active: true });
    await system.run.updateMany({ where: { routineId: routine.id }, data: { status: "failed" } });

    for (let i = 0; i < 2; i += 1) await failedRun(routine.id);
    await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
    await executor().wakeRoutine(routine.id, dueAt.toISOString());
    const ended = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(ended).toMatchObject({ active: false, nextRunAt: null });
    // One run from the resumed firing and two more failures; no fourth run.
    await expect(system.run.count({ where: { routineId: routine.id } })).resolves.toBe(6);
    expect(await lastNote()).toContain("PR watch routine ended: 3 failed runs in a row");
  });

  it("keeps a routine with no end set running however often it fails", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "daily",
        prompt: "report",
        crons: ["*/5 * * * *"],
        active: true,
        nextRunAt: dueAt,
      },
    });
    for (let i = 0; i < 3; i += 1) await failedRun(routine.id);
    await executor().wakeRoutine(routine.id, dueAt.toISOString());
    await expect(
      system.routine.findUniqueOrThrow({ where: { id: routine.id } }),
    ).resolves.toMatchObject({ active: true });
    await expect(system.run.count({ where: { routineId: routine.id } })).resolves.toBe(4);
  });

  it("lets only the routine's own run report its condition met", async () => {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "Ticket watch",
        prompt: "check the ticket",
        crons: ["*/5 * * * *"],
        active: true,
        nextRunAt: new Date(Date.now() + 5 * 60_000),
        until: "the ticket is closed",
      },
    });
    const run = { ...identity, trigger: "routine", routineId: routine.id };
    await expect(
      finishRoutineFromRun(deps(), { ...run, trigger: "user", routineId: null }),
    ).resolves.toEqual({ error: "Only a run of the routine itself can finish it." });
    await expect(finishRoutineFromRun(deps(), { ...run, botId: "another-bot" })).resolves.toEqual({
      error: "Schedule not found.",
    });
    await expect(
      system.routine.findUniqueOrThrow({ where: { id: routine.id } }),
    ).resolves.toMatchObject({ active: true });

    jobs.cancelled.length = 0;
    await expect(finishRoutineFromRun(deps(), run)).resolves.toMatchObject({
      ok: true,
      active: false,
    });
    await expect(
      system.routine.findUniqueOrThrow({ where: { id: routine.id } }),
    ).resolves.toMatchObject({ active: false, nextRunAt: null });
    expect(jobs.cancelled).toHaveLength(1);
    expect(await lastNote()).toContain("Ticket watch routine ended: done");
  });

  it("refuses to finish a routine that has no done condition", async () => {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "plain",
        prompt: "report",
        crons: ["*/5 * * * *"],
        active: true,
        nextRunAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    await expect(
      finishRoutineFromRun(deps(), { ...identity, trigger: "routine", routineId: routine.id }),
    ).resolves.toEqual({ error: "This routine has no end condition." });
  });

  it("moves a held firing when schedule_update moves the end, and drops a passed end on resume", async () => {
    const heldAt = new Date(Date.now() + 60 * 60_000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "held",
        prompt: "report",
        crons: ["0 0 1 1 *"],
        active: true,
        nextRunAt: heldAt,
        endsAt: heldAt,
      },
    });
    const update = (input: Partial<Parameters<typeof updateScheduleFromTool>[1]>) =>
      updateScheduleFromTool(deps() as unknown as Parameters<typeof updateScheduleFromTool>[0], {
        ...identity,
        routineId: routine.id,
        schedule: {},
        ...input,
      });

    const later = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await expect(update({ end: { endsAt: later.toISOString() } })).resolves.toMatchObject({
      ok: true,
    });
    const moved = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(moved.endsAt).toEqual(later);
    // Held no longer: the next real occurrence, or the new end if that comes first.
    expect(moved.nextRunAt!.getTime()).toBeGreaterThan(heldAt.getTime());
    expect(moved.nextRunAt!.getTime()).toBeLessThanOrEqual(later.getTime());

    const passed = new Date(Date.now() - 60_000);
    await system.routine.update({
      where: { id: routine.id },
      data: { active: false, nextRunAt: null, endsAt: passed, endedAt: passed },
    });
    await expect(update({ active: true })).resolves.toMatchObject({ ok: true, active: true });
    const resumed = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(resumed).toMatchObject({ active: true, endsAt: null });
    expect(resumed.nextRunAt).toBeInstanceOf(Date);
  });
});
