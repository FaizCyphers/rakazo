import {
  COMPUTER_PROVIDER_UNAVAILABLE_ERROR,
  COMPUTER_RATE_LIMIT_ERROR,
  COMPUTER_UNRESPONSIVE_ERROR,
} from "@rakazo/contracts";
import {
  MISSING_MODEL_RUN_ERROR,
  MODEL_ACCESS_REQUIRED_RUN_ERROR,
  MODEL_CREDIT_CAP_REACHED_ERROR,
  normalizeRunError,
} from "./run-error.js";
import { stuckWorkStatusMessage } from "./stuck-work.js";

/**
 * Why a ticket's work stopped. `cut_off`, `provider` and `race` are retried on a schedule;
 * `needs_you` waits for a person to fix one thing; `other` waits for a person to look.
 */
export type TicketStuckKind = "cut_off" | "provider" | "race" | "needs_you" | "other";
export type TicketRetryKind = Extract<TicketStuckKind, "cut_off" | "provider" | "race">;

/** How long each retry of a kind waits; its length is how many tries the kind gets. */
export const TICKET_RETRY_DELAYS_MS: Record<TicketRetryKind, readonly number[]> = {
  cut_off: [2 * 60_000, 5 * 60_000],
  provider: [2 * 60_000, 10 * 60_000, 30 * 60_000],
  race: [60_000, 3 * 60_000, 10 * 60_000],
};

/** A provider's retry-after shorter than this still waits this long. */
const MIN_RETRY_AFTER_MS = 30_000;

export type TicketStuckCause = {
  kind: TicketStuckKind;
  /** What went wrong, for a person. */
  summary: string;
  /** For `needs_you`: the one thing to do. */
  step?: string;
  /** The provider's own wait, when it said one. */
  retryAfterMs?: number;
};

/** The ticket's latest run, or null when none ever ran. */
export type TicketRunEnd = { status: string; error: string | null } | null;

export const TICKET_STEP_CONNECT_MODEL = "Connect a model in Settings → Models.";
export const TICKET_STEP_CHOOSE_MODEL = "Choose another model in Settings → Models.";
export const TICKET_STEP_RECONNECT = "Sign in again where the bot's account is connected.";
export const TICKET_STEP_ALLOW = "Allow the action the bot asked for.";

const CUT_OFF =
  /\b(?:interrupted|aborted|lease (?:was )?(?:lost|expired)|lost (?:its|the) lease|restart(?:ed|ing)|shutting down|shut down|process (?:died|exited|crashed)|worker (?:stopped|exited))\b/i;
const RACE =
  /\b(?:deadlock|could not serialize|serialization failure|lock (?:not available|timeout)|lease (?:conflict|held|exists)|already (?:claimed|leased)|write conflict)\b|^Internal server error$/i;
const PROVIDER_BUSY =
  /\b(?:overload(?:ed)?|over capacity|capacity|temporarily unavailable|service unavailable|rate[_ -]?limit(?:ed)?|too many requests|timed?[_ -]?out|timeout|took too long|couldn't be reached)\b/i;
const SIGN_IN =
  /\b(?:sign[ -]?in|signed out|reconnect|re-?authori[sz]|credentials?|not connected|connect (?:that|the|a|your) (?:model|provider|account))\b/i;
const DENIED = /\b(?:permission denied|approval (?:was )?denied|denied the)\b/i;
const BILLING = /\b(?:billing|subscribe)\b/i;
const RETRY_AFTER = /\bretry[-_ ]after\\?"?\s*[:=]\s*\\?"?(\d+(?:\.\d+)?)/i;

function retryAfterMs(text: string): number | undefined {
  const seconds = Number(text.match(RETRY_AFTER)?.[1]);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.max(seconds * 1000, MIN_RETRY_AFTER_MS)
    : undefined;
}

/**
 * Sorts how a ticket's latest run ended into a kind, from what the run stored. Null means it
 * needs nothing: the run is still going, or a person stopped it.
 */
export function classifyTicketRunEnd(run: TicketRunEnd, now = Date.now()): TicketStuckCause | null {
  if (!run) return { kind: "cut_off", summary: "No run is working on it." };
  const error = run.error?.trim() ?? "";
  if (run.status === "completed")
    return { kind: "cut_off", summary: "The run ended before the ticket was finished." };
  if (run.status === "cancelled") {
    // A person's stop leaves no error; only the stuck-work cleanup writes one.
    if (!error) return null;
    if (error === stuckWorkStatusMessage("queued")) return { kind: "cut_off", summary: error };
    return { kind: "other", summary: error };
  }
  if (run.status !== "failed") return null;
  if (!error) return { kind: "other", summary: "The run failed." };

  const normalized = normalizeRunError(error, undefined, undefined, now);
  const summary = normalized.summary;
  if (error === MODEL_ACCESS_REQUIRED_RUN_ERROR || error === MODEL_CREDIT_CAP_REACHED_ERROR)
    return { kind: "needs_you", summary, step: error };
  if (error === MISSING_MODEL_RUN_ERROR || normalized.recovery === "connection")
    return { kind: "needs_you", summary, step: TICKET_STEP_CONNECT_MODEL };
  if (normalized.recovery === "plan") return { kind: "needs_you", summary, step: error };
  if (
    normalized.kind === "model" ||
    normalized.kind === "access" ||
    normalized.kind === "credit" ||
    normalized.kind === "spending"
  )
    return { kind: "needs_you", summary, step: TICKET_STEP_CHOOSE_MODEL };
  if (normalized.kind === "context" || normalized.kind === "output")
    return { kind: "other", summary };
  if (DENIED.test(error)) return { kind: "needs_you", summary, step: TICKET_STEP_ALLOW };
  if (SIGN_IN.test(error))
    return {
      kind: "needs_you",
      summary,
      step: /\b(?:model|provider)\b/i.test(error)
        ? TICKET_STEP_CONNECT_MODEL
        : TICKET_STEP_RECONNECT,
    };
  if (BILLING.test(error) && !PROVIDER_BUSY.test(error))
    return { kind: "needs_you", summary, step: TICKET_STEP_CHOOSE_MODEL };
  if (RACE.test(error)) return { kind: "race", summary };
  if (
    normalized.kind === "rate" ||
    [408, 429, 502, 503, 504, 529].includes(normalized.status ?? 0) ||
    error === COMPUTER_RATE_LIMIT_ERROR ||
    error === COMPUTER_PROVIDER_UNAVAILABLE_ERROR ||
    error === COMPUTER_UNRESPONSIVE_ERROR ||
    PROVIDER_BUSY.test(error) ||
    PROVIDER_BUSY.test(summary)
  ) {
    const wait = retryAfterMs(error);
    return { kind: "provider", summary, ...(wait ? { retryAfterMs: wait } : {}) };
  }
  if (CUT_OFF.test(error)) return { kind: "cut_off", summary };
  return { kind: "other", summary };
}

/**
 * What recovery has done for a ticket, stored on it. `runId` is the latest run it has seen;
 * `kind` is set while a decision about that run stands. A person's change keeps `runId` and
 * drops the rest, so the failure they saw is not acted on again.
 */
export type TicketRecoveryState = {
  runId: string | null;
  kind?: TicketStuckKind;
  tries: Partial<Record<TicketRetryKind, number>>;
};

const STUCK_KINDS = new Set<string>(["cut_off", "provider", "race", "needs_you", "other"]);

export function isTicketRetryKind(kind: string | undefined): kind is TicketRetryKind {
  return kind === "cut_off" || kind === "provider" || kind === "race";
}

export function coerceTicketRecovery(value: unknown): TicketRecoveryState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const runId = typeof record.runId === "string" ? record.runId : null;
  const kind =
    typeof record.kind === "string" && STUCK_KINDS.has(record.kind)
      ? (record.kind as TicketStuckKind)
      : undefined;
  const tries: TicketRecoveryState["tries"] = {};
  const stored =
    record.tries && typeof record.tries === "object"
      ? (record.tries as Record<string, unknown>)
      : {};
  for (const key of Object.keys(TICKET_RETRY_DELAYS_MS) as TicketRetryKind[]) {
    const count = stored[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) tries[key] = count;
  }
  return { runId, ...(kind ? { kind } : {}), tries };
}

/** Added to a retry's wake, so the bot picks up its work instead of starting over. */
export const TICKET_RETRY_WAKE_NOTE =
  "Your last run on this ticket stopped before it finished. Keep the work you already did and continue from where it stopped.";

export type TicketRecoveryDecision =
  | { action: "retry"; kind: TicketRetryKind; delayMs: number; tries: number }
  | { action: "needs_you"; step: string; comment: string }
  | { action: "block"; comment: string };

const KIND_SENTENCE: Record<Exclude<TicketStuckKind, "needs_you">, string> = {
  cut_off: "The work was cut off",
  provider: "The provider was unavailable",
  race: "The work hit a conflict",
  other: "The run failed",
};

/** What to do about a stuck ticket, given why it stopped and the tries each kind already had. */
export function decideTicketRecovery(
  cause: TicketStuckCause,
  tries: TicketRecoveryState["tries"],
): TicketRecoveryDecision {
  if (cause.kind === "needs_you") {
    const step = cause.step ?? cause.summary;
    return {
      action: "needs_you",
      step,
      comment:
        step === cause.summary ? `Needs you: ${step}` : `Needs you: ${step}\n${cause.summary}`,
    };
  }
  if (!isTicketRetryKind(cause.kind))
    return { action: "block", comment: `Blocked. ${KIND_SENTENCE.other}.\n${cause.summary}` };
  const delays = TICKET_RETRY_DELAYS_MS[cause.kind];
  const used = tries[cause.kind] ?? 0;
  if (used >= delays.length) {
    return {
      action: "block",
      comment: `Blocked. ${KIND_SENTENCE[cause.kind]} ${used} times in a row.\n${cause.summary}`,
    };
  }
  return {
    action: "retry",
    kind: cause.kind,
    delayMs: cause.kind === "provider" && cause.retryAfterMs ? cause.retryAfterMs : delays[used]!,
    tries: used + 1,
  };
}
