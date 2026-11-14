import type { JobPublisher } from "@rakazo/adapter-kit";
import { ticketRecoverJob, ticketRecoverJobKey } from "@rakazo/adapter-kit";
import { hasLab, resolveLabs, TICKET_COMMENT_MAX_LENGTH, ticketRef } from "@rakazo/contracts";
import type { TicketRecoveryDecision, TicketRecoveryState } from "@rakazo/core";
import {
  ACTIVE_RUN_STATUSES,
  classifyTicketRunEnd,
  coerceTicketRecovery,
  decideTicketRecovery,
  displayName,
  isTicketRetryKind,
  TICKET_RETRY_WAKE_NOTE,
} from "@rakazo/core";
import { Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { notifyRun } from "./run-notifications.js";
import { waitsOnIncomplete } from "./ticket-wake.js";

const SWEEP_BATCH = 100;
const NO_RUN_SUMMARY = "No run is working on it.";

type Tx = Prisma.TransactionClient;

/** A decision made about a stuck ticket, for the caller to finish after its commit. */
export type TicketRecoveryApplied = {
  ticketId: string;
  spaceId: string;
  boardId: string;
  ref: string;
  assigneeBotId: string;
  decision: TicketRecoveryDecision;
};

function latestTicketRun(tx: Tx, ticketId: string) {
  return tx.run.findFirst({
    where: { task: { ticketId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true, error: true },
  });
}

function hasLiveTicketRun(tx: Tx, ticketId: string) {
  return tx.run
    .findFirst({
      where: { task: { ticketId }, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    })
    .then(Boolean);
}

/** In progress, or ready to start: its bot should be working on it. */
async function lockWorkableTicket(tx: Tx, ticketId: string) {
  await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticketId} FOR UPDATE`;
  const ticket = await tx.ticket.findUnique({
    where: { id: ticketId },
    include: { board: { select: { ticketPrefix: true } } },
  });
  if (!ticket?.assigneeBotId) return null;
  if (ticket.status !== "doing" && ticket.status !== "todo") return null;
  if (ticket.status === "todo" && (await waitsOnIncomplete(tx, ticket.id))) return null;
  const verification = ticket.verification as { state?: unknown } | null;
  // A check of the last run is under way; its outcome decides what happens next.
  if (verification?.state === "pending") return null;
  if (await hasLiveTicketRun(tx, ticket.id)) return null;
  return { ...ticket, assigneeBotId: ticket.assigneeBotId };
}

/**
 * Inside a transaction: when the ticket is stuck, decide what to do about how its latest run
 * ended and record it. A retry is scheduled as its keyed job; a failure that needs a person, or
 * retries used up, blocks the ticket with a comment. Returns null when nothing was decided:
 * the ticket is not stuck, a person stopped its run, or this run was already decided on.
 */
export async function decideStuckTicket(
  tx: Tx,
  jobs: Pick<JobPublisher, "enqueueIn" | "cancelIn">,
  ticketId: string,
  now = new Date(),
): Promise<TicketRecoveryApplied | null> {
  const ticket = await lockWorkableTicket(tx, ticketId);
  if (!ticket) return null;
  const latest = await latestTicketRun(tx, ticket.id);
  const runId = latest?.id ?? null;
  const prior = coerceTicketRecovery(ticket.recovery);
  const seen = prior?.runId === runId;
  if (seen && prior.kind) return null;
  let cause = classifyTicketRunEnd(latest, now.getTime());
  if (!cause) return null;
  // A person changed the ticket since this run ended: what they saw is theirs to judge, so its
  // bot is only started again.
  if (seen) cause = { kind: "cut_off", summary: NO_RUN_SUMMARY };
  const tries = prior?.tries ?? {};
  const decision = decideTicketRecovery(cause, tries);
  const recovery: TicketRecoveryState = {
    runId,
    kind: cause.kind,
    tries: decision.action === "retry" ? { ...tries, [decision.kind]: decision.tries } : tries,
  };
  if (decision.action === "retry") {
    await tx.ticket.update({ where: { id: ticket.id }, data: { recovery } });
    await jobs.enqueueIn(
      tx,
      ticketRecoverJob(ticket.id, new Date(now.getTime() + decision.delayMs)),
    );
  } else {
    await tx.ticket.update({
      where: { id: ticket.id },
      data: { recovery, status: "blocked", completedAt: null },
    });
    await tx.ticketComment.create({
      data: {
        ticketId: ticket.id,
        spaceId: ticket.spaceId,
        body: decision.comment.slice(0, TICKET_COMMENT_MAX_LENGTH),
      },
    });
    await jobs.cancelIn(tx, ticketRecoverJobKey(ticket.id));
  }
  return {
    ticketId: ticket.id,
    spaceId: ticket.spaceId,
    boardId: ticket.boardId,
    ref: ticketRef(ticket.board.ticketPrefix, ticket.number),
    assigneeBotId: ticket.assigneeBotId,
    decision,
  };
}

/** Inside the transaction that fails a run: the run's ticket, if it worked one, is decided on. */
export async function recordTicketRunFailure(
  tx: Tx,
  jobs: Pick<JobPublisher, "enqueueIn" | "cancelIn">,
  taskId: string,
): Promise<TicketRecoveryApplied | null> {
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { ticketId: true } });
  return task?.ticketId ? decideStuckTicket(tx, jobs, task.ticketId) : null;
}

/**
 * After commit: shows a blocked ticket on the board, and tells the bot's owner the one step it
 * needs from them. Best effort; the ticket's status and comment are already saved.
 */
export async function finishTicketRecovery(
  deps: ExecutorDeps,
  applied: TicketRecoveryApplied,
): Promise<void> {
  const { decision } = applied;
  if (decision.action === "retry") return;
  try {
    await deps.onTicketChange?.({
      spaceId: applied.spaceId,
      boardId: applied.boardId,
      ticketId: applied.ticketId,
      assigneeBotId: applied.assigneeBotId,
      wakeAssignee: false,
    });
    if (decision.action !== "needs_you") return;
    const bot = await deps.prisma.bot.findUnique({
      where: { id: applied.assigneeBotId },
      select: { name: true, userId: true, thread: { select: { id: true } } },
    });
    if (!bot?.thread) return;
    await notifyRun(
      deps,
      {
        spaceId: applied.spaceId,
        userId: bot.userId,
        botId: applied.assigneeBotId,
        threadId: bot.thread.id,
        trigger: "tickets",
      },
      {
        kind: "help",
        title: `${displayName(bot.name, "Bot")} needs you`,
        body: `${applied.ref}: ${decision.step}`,
        botId: applied.assigneeBotId,
        threadId: bot.thread.id,
      },
    );
  } catch (error) {
    getLogger().error("stuck ticket follow-up failed", error);
  }
}

/**
 * The ticket's retry is due: wakes its bot to carry on, unless the ticket moved on since. A
 * repeat finds the new run and does nothing.
 */
export async function retryStuckTicket(deps: ExecutorDeps, ticketId: string): Promise<boolean> {
  const ticket = await deps.prisma.$transaction(async (tx) => {
    const ticket = await lockWorkableTicket(tx, ticketId);
    if (!ticket) return null;
    const state = coerceTicketRecovery(ticket.recovery);
    if (!state || !isTicketRetryKind(state.kind)) return null;
    // A newer run than the one this retry is for already ran.
    if (((await latestTicketRun(tx, ticket.id))?.id ?? null) !== state.runId) return null;
    return ticket;
  });
  if (!ticket) return false;
  await deps.onTicketChange?.({
    spaceId: ticket.spaceId,
    boardId: ticket.boardId,
    ticketId: ticket.id,
    assigneeBotId: ticket.assigneeBotId,
    wakeAssignee: true,
    wakeNote: TICKET_RETRY_WAKE_NOTE,
  });
  return true;
}

/**
 * Slow safety net for tickets a failure hook never saw: in progress (or ready) with a bot, no
 * live run, no check pending, and a latest run nobody has decided on yet. Returns how many it
 * decided on.
 */
export async function sweepStuckTickets(deps: ExecutorDeps): Promise<number> {
  const active = Prisma.join([...ACTIVE_RUN_STATUSES]);
  const candidates = await deps.prisma.$queryRaw<Array<{ id: string; labs: string[] | null }>>`
    SELECT t.id, u.labs
    FROM tickets t
    JOIN bots b ON b.id = t."assigneeBotId"
    JOIN "user" u ON u.id = b."userId"
    LEFT JOIN LATERAL (
      SELECT r.id, r.status, r.error FROM tasks k JOIN runs r ON r."taskId" = k.id
      WHERE k."ticketId" = t.id
      ORDER BY r."createdAt" DESC, r.id DESC LIMIT 1
    ) latest ON TRUE
    WHERE (
        t.status = 'doing'
        OR (t.status = 'todo' AND NOT EXISTS (
          SELECT 1 FROM ticket_dependencies d JOIN tickets p ON p.id = d."dependsOnTicketId"
          WHERE d."ticketId" = t.id AND p.status NOT IN ('done', 'closed')
        ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks k JOIN runs r ON r."taskId" = k.id
        WHERE k."ticketId" = t.id AND r.status IN (${active})
      )
      AND (t.verification IS NULL OR t.verification->>'state' IS DISTINCT FROM 'pending')
      AND NOT ((t.recovery->>'kind') IS NOT NULL AND (t.recovery->>'runId') IS NOT DISTINCT FROM latest.id)
      AND NOT (latest.status = 'cancelled' AND COALESCE(latest.error, '') = '')
    ORDER BY t."updatedAt" ASC
    LIMIT ${SWEEP_BATCH}`;
  let decided = 0;
  for (const candidate of candidates) {
    if (!hasLab(resolveLabs(candidate.labs, deps.deploymentLabs), "board")) continue;
    try {
      const applied = await deps.prisma.$transaction((tx) =>
        decideStuckTicket(tx, deps.jobs, candidate.id),
      );
      if (!applied) continue;
      decided += 1;
      await finishTicketRecovery(deps, applied);
    } catch (error) {
      getLogger().error("stuck ticket check failed", error);
    }
  }
  return decided;
}

/** The sweep is a safety net, so it runs at most once a minute whatever the reconciler's pace. */
export function createStuckTicketSweeper(
  sweep: () => Promise<unknown>,
  intervalMs = 60_000,
): () => Promise<void> {
  let lastRun: number | undefined;
  return async () => {
    const now = Date.now();
    if (lastRun !== undefined && now - lastRun < intervalMs) return;
    lastRun = now;
    await sweep();
  };
}

/**
 * What a person's move or edit leaves: no tries used, and the run that had already ended
 * marked seen, so its failure is not acted on again. A run still going is decided on as usual.
 */
export async function clearedTicketRecovery(
  tx: Tx,
  ticketId: string,
): Promise<TicketRecoveryState> {
  const latest = await latestTicketRun(tx, ticketId);
  const ended = latest && !(ACTIVE_RUN_STATUSES as readonly string[]).includes(latest.status);
  return { runId: ended ? latest.id : null, tries: {} };
}
