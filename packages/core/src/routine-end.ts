import { ROUTINE_FAILURES_TO_END } from "@rakazo/contracts";

/** Why a routine turned itself off: its end time, a run reporting its condition, or failures. */
export type RoutineEndReason = "deadline" | "done" | "failures";

type RoutineEnd = { endsAt: Date | null; until: string | null };

/** Whether failures in a row end this routine: only one set to end on its own. */
export function routineEndsOnFailures(routine: RoutineEnd): boolean {
  return Boolean(routine.endsAt || routine.until);
}

/**
 * Why a firing due at `dueAt` ends the routine instead of running it, or null to run it.
 * `recentRunStatuses` are the routine's latest runs since it last ended, newest first.
 */
export function routineEndBeforeRun(
  routine: RoutineEnd,
  dueAt: Date,
  recentRunStatuses: readonly string[],
): RoutineEndReason | null {
  if (routine.endsAt && dueAt.getTime() >= routine.endsAt.getTime()) return "deadline";
  if (
    routineEndsOnFailures(routine) &&
    recentRunStatuses.length >= ROUTINE_FAILURES_TO_END &&
    recentRunStatuses.slice(0, ROUTINE_FAILURES_TO_END).every((status) => status === "failed")
  ) {
    return "failures";
  }
  return null;
}

/** The next firing, held at the end time so the routine wakes once more to end itself. */
export function routineNextRunBeforeEnd<T extends Date | null>(next: T, endsAt: Date | null): T {
  if (!next || !endsAt) return next;
  return (next.getTime() > endsAt.getTime() ? endsAt : next) as T;
}

/** The note the routine's chat gets when it ends itself. */
export function routineEndedText(name: string, reason: RoutineEndReason): string {
  if (reason === "deadline") return `${name} routine ended: end time reached`;
  if (reason === "done") return `${name} routine ended: done`;
  return `${name} routine ended: ${ROUTINE_FAILURES_TO_END} failed runs in a row`;
}

/** What a run of a routine with a done condition is told about it. */
export function routineUntilInstruction(until: string): string {
  return `This routine ends once this is true: ${until}\nIf it is true now, call schedule_finish after reporting. Otherwise do the routine as usual.`;
}
