import { COMPUTER_UNRESPONSIVE_ERROR } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { MISSING_MODEL_RUN_ERROR, MODEL_ACCESS_REQUIRED_RUN_ERROR } from "./run-error.js";
import { stuckWorkStatusMessage } from "./stuck-work.js";
import {
  classifyTicketRunEnd,
  coerceTicketRecovery,
  decideTicketRecovery,
  TICKET_RETRY_DELAYS_MS,
  TICKET_STEP_CHOOSE_MODEL,
  TICKET_STEP_CONNECT_MODEL,
  TICKET_STEP_RECONNECT,
} from "./ticket-recovery.js";

const failed = (error: string) => classifyTicketRunEnd({ status: "failed", error });
const minutes = (n: number) => n * 60_000;

describe("classifyTicketRunEnd", () => {
  it.each([
    ["the worker process died mid-run", "cut_off"],
    ["Model request was aborted", "cut_off"],
    ["The run was interrupted by a restart", "cut_off"],
    ['429: {"error":{"message":"Too many requests"}}', "provider"],
    ['503 {"error":{"message":"Service unavailable"}}', "provider"],
    ["Anthropic API error (529): overloaded", "provider"],
    ["Request timed out", "provider"],
    [COMPUTER_UNRESPONSIVE_ERROR, "provider"],
    ["Internal server error", "race"],
    ["deadlock detected", "race"],
    ["could not serialize access due to concurrent update", "race"],
    [MISSING_MODEL_RUN_ERROR, "needs_you"],
    ['401: {"error":{"message":"Invalid API key"}}', "needs_you"],
    ['404 {"error":{"message":"model not found"}}', "needs_you"],
    ['402 {"error":{"message":"Insufficient credits"}}', "needs_you"],
    ["The sign-in token expired or was revoked. Connect that model provider again.", "needs_you"],
    ["Permission denied", "needs_you"],
    [MODEL_ACCESS_REQUIRED_RUN_ERROR, "needs_you"],
    ["This conversation is too long: prompt is too long", "other"],
    ["TypeError: cannot read properties of undefined", "other"],
  ])("%s → %s", (error, kind) => {
    expect(failed(error)?.kind).toBe(kind);
  });

  it("names the one step that fixes a needs-you failure", () => {
    expect(failed(MISSING_MODEL_RUN_ERROR)?.step).toBe(TICKET_STEP_CONNECT_MODEL);
    expect(failed('401: {"error":{"message":"Invalid API key"}}')?.step).toBe(
      TICKET_STEP_CONNECT_MODEL,
    );
    expect(failed('404 {"error":{"message":"model not found"}}')?.step).toBe(
      TICKET_STEP_CHOOSE_MODEL,
    );
    expect(failed("The connector needs you to sign in again")?.step).toBe(TICKET_STEP_RECONNECT);
    expect(failed(MODEL_ACCESS_REQUIRED_RUN_ERROR)?.step).toBe(MODEL_ACCESS_REQUIRED_RUN_ERROR);
  });

  it("keeps a provider's retry-after", () => {
    expect(failed('429: {"error":{"message":"slow down","retry-after":"90"}}')).toMatchObject({
      kind: "provider",
      retryAfterMs: 90_000,
    });
  });

  it("never retries a person's stop, and sorts the cleanup's stops", () => {
    expect(classifyTicketRunEnd({ status: "cancelled", error: null })).toBeNull();
    expect(classifyTicketRunEnd({ status: "cancelled", error: "" })).toBeNull();
    expect(
      classifyTicketRunEnd({ status: "cancelled", error: stuckWorkStatusMessage("queued") })?.kind,
    ).toBe("cut_off");
    expect(
      classifyTicketRunEnd({ status: "cancelled", error: stuckWorkStatusMessage("waiting_input") })
        ?.kind,
    ).toBe("other");
  });

  it("treats a ticket with no run, or a finished run that left it open, as cut off", () => {
    expect(classifyTicketRunEnd(null)?.kind).toBe("cut_off");
    expect(classifyTicketRunEnd({ status: "completed", error: null })?.kind).toBe("cut_off");
    expect(classifyTicketRunEnd({ status: "running", error: null })).toBeNull();
  });
});

describe("decideTicketRecovery", () => {
  it.each([
    ["cut_off", [2, 5]],
    ["provider", [2, 10, 30]],
    ["race", [1, 3, 10]],
  ] as const)("retries %s on its schedule, then blocks", (kind, schedule) => {
    expect(TICKET_RETRY_DELAYS_MS[kind]).toEqual(schedule.map(minutes));
    const cause = { kind, summary: "It stopped." } as const;
    schedule.forEach((delay, used) => {
      const decision = decideTicketRecovery(cause, { [kind]: used });
      expect(decision).toMatchObject({
        action: "retry",
        kind,
        delayMs: minutes(delay),
        tries: used + 1,
      });
    });
    const exhausted = decideTicketRecovery(cause, { [kind]: schedule.length });
    expect(exhausted).toMatchObject({ action: "block" });
    expect(exhausted.action === "block" && exhausted.comment).toContain(
      `${schedule.length} times in a row.\nIt stopped.`,
    );
  });

  it("counts each kind apart", () => {
    expect(
      decideTicketRecovery({ kind: "provider", summary: "Busy." }, { cut_off: 2 }),
    ).toMatchObject({ action: "retry", tries: 1 });
  });

  it("waits the provider's retry-after instead of its schedule", () => {
    expect(
      decideTicketRecovery({ kind: "provider", summary: "Busy.", retryAfterMs: 45_000 }, {}),
    ).toMatchObject({ action: "retry", delayMs: 45_000 });
  });

  it("asks a person once for a needs-you failure, and blocks anything else", () => {
    expect(
      decideTicketRecovery(
        { kind: "needs_you", summary: "Key rejected.", step: TICKET_STEP_CONNECT_MODEL },
        {},
      ),
    ).toEqual({
      action: "needs_you",
      step: TICKET_STEP_CONNECT_MODEL,
      comment: `Needs you: ${TICKET_STEP_CONNECT_MODEL}\nKey rejected.`,
    });
    expect(decideTicketRecovery({ kind: "other", summary: "Too long." }, {})).toEqual({
      action: "block",
      comment: "Blocked. The run failed.\nToo long.",
    });
  });
});

describe("coerceTicketRecovery", () => {
  it("keeps only what it understands", () => {
    expect(coerceTicketRecovery(null)).toBeNull();
    expect(
      coerceTicketRecovery({ runId: "r1", kind: "race", tries: { race: 2, nope: 3, cut_off: -1 } }),
    ).toEqual({ runId: "r1", kind: "race", tries: { race: 2 } });
    expect(coerceTicketRecovery({ kind: "weird", tries: "x" })).toEqual({ runId: null, tries: {} });
  });
});
