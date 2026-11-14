import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey } from "@rakazo/adapter-kit";
import { ROUTINE_FAILURES_TO_END } from "@rakazo/contracts";
import type { RoutineEndReason } from "@rakazo/core";
import { routineEndBeforeRun, routineEndedText, routineEndsOnFailures } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { postRoutineWatchMessage } from "./routine-watch.js";

interface RoutineEndDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
}

type EndingRoutine = {
  id: string;
  name: string;
  spaceId: string;
  botId: string;
  threadId: string | null;
  endsAt: Date | null;
  until: string | null;
  endedAt: Date | null;
};

/** Why a firing due at `dueAt` ends the routine instead of running it, or null to run it. */
export async function routineEndDue(
  prisma: PrismaClient,
  routine: EndingRoutine,
  dueAt: Date,
): Promise<RoutineEndReason | null> {
  const recent = routineEndsOnFailures(routine)
    ? await prisma.run.findMany({
        where: {
          routineId: routine.id,
          ...(routine.endedAt ? { createdAt: { gt: routine.endedAt } } : {}),
        },
        select: { status: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: ROUTINE_FAILURES_TO_END,
      })
    : [];
  return routineEndBeforeRun(
    routine,
    dueAt,
    recent.map((run) => run.status),
  );
}

/**
 * Turn a routine off for `reason` and say so in its chat. With `dueAt`, only while that firing is
 * still the pending one, so an edit or another wake that moved it on wins. Returns whether it ended.
 */
export async function endRoutine(
  deps: RoutineEndDeps,
  routine: Omit<EndingRoutine, "endsAt" | "until" | "endedAt">,
  reason: RoutineEndReason,
  dueAt?: Date,
): Promise<boolean> {
  const ended = await deps.prisma.routine.updateMany({
    where: { id: routine.id, active: true, ...(dueAt ? { nextRunAt: dueAt } : {}) },
    data: { active: false, nextRunAt: null, endedAt: new Date() },
  });
  if (ended.count !== 1) return false;
  getLogger().info("routine.ended", { "routine.id": routine.id, reason });
  // The wake that found it due is the job itself; any other one would only find it off.
  if (!dueAt) await deps.jobs.cancel(routineJobKey(routine.id)).catch(() => undefined);
  const threadId =
    routine.threadId ??
    (
      await deps.prisma.thread.findFirst({
        where: { botId: routine.botId, spaceId: routine.spaceId },
        select: { id: true },
      })
    )?.id;
  if (!threadId) return true;
  await deps.events
    .append({
      spaceId: routine.spaceId,
      threadId,
      botId: routine.botId,
      type: "routine.updated",
      payload: { routineId: routine.id, active: false, ended: reason },
    })
    .catch(() => undefined);
  await postRoutineWatchMessage(deps, {
    spaceId: routine.spaceId,
    threadId,
    botId: routine.botId,
    role: "system",
    text: routineEndedText(routine.name, reason),
  });
  return true;
}

/** `schedule_finish`: a run of a routine with a done condition reports it met. */
export async function finishRoutineFromRun(
  deps: RoutineEndDeps,
  run: { trigger: string; routineId: string | null; spaceId: string; botId: string },
) {
  if (run.trigger !== "routine" || !run.routineId) {
    return { error: "Only a run of the routine itself can finish it." };
  }
  const routine = await deps.prisma.routine.findFirst({
    where: { id: run.routineId, spaceId: run.spaceId, botId: run.botId },
  });
  if (!routine) return { error: "Schedule not found." };
  if (!routine.until) return { error: "This routine has no end condition." };
  await endRoutine(deps, routine, "done");
  return { ok: true as const, routineId: routine.id, name: routine.name, active: false };
}
