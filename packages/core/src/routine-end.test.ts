import { describe, expect, it } from "vitest";
import { routineEndBeforeRun, routineNextRunBeforeEnd } from "./routine-end.js";

describe("routine end", () => {
  const due = new Date("2026-11-20T09:00:00Z");
  const endsAt = new Date("2026-11-20T09:00:00Z");
  const failed = ["failed", "failed", "failed"];

  it("ends a firing due at or after its end time", () => {
    expect(routineEndBeforeRun({ endsAt, until: null }, due, [])).toBe("deadline");
    expect(routineEndBeforeRun({ endsAt, until: null }, new Date(due.getTime() + 60_000), [])).toBe(
      "deadline",
    );
    expect(
      routineEndBeforeRun({ endsAt, until: null }, new Date(due.getTime() - 60_000), []),
    ).toBeNull();
  });

  it("ends after three failed runs in a row only when set to end on its own", () => {
    const early = new Date(due.getTime() - 60_000);
    expect(routineEndBeforeRun({ endsAt, until: null }, early, failed)).toBe("failures");
    expect(routineEndBeforeRun({ endsAt: null, until: "the PR merged" }, due, failed)).toBe(
      "failures",
    );
    expect(routineEndBeforeRun({ endsAt: null, until: null }, due, failed)).toBeNull();
  });

  it("keeps running while the latest runs are not all failures", () => {
    const routine = { endsAt: null, until: "the PR merged" };
    expect(routineEndBeforeRun(routine, due, ["failed", "failed"])).toBeNull();
    expect(routineEndBeforeRun(routine, due, ["failed", "completed", "failed"])).toBeNull();
    expect(routineEndBeforeRun(routine, due, ["running", "failed", "failed", "failed"])).toBeNull();
    expect(routineEndBeforeRun(routine, due, ["failed", "failed", "failed", "completed"])).toBe(
      "failures",
    );
  });

  it("holds the next firing at the end time", () => {
    const later = new Date(endsAt.getTime() + 3_600_000);
    const sooner = new Date(endsAt.getTime() - 3_600_000);
    expect(routineNextRunBeforeEnd(later, endsAt)).toEqual(endsAt);
    expect(routineNextRunBeforeEnd(sooner, endsAt)).toEqual(sooner);
    expect(routineNextRunBeforeEnd(later, null)).toEqual(later);
    expect(routineNextRunBeforeEnd(null, endsAt)).toBeNull();
  });
});
