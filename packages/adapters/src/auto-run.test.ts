import type { ModelRoleChoice } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { orderAutoPool, parseEffortRating, planKey, rateTaskEffort } from "./auto-run.js";
import { ModelQuotaLedger } from "./model-quota.js";

const claude: ModelRoleChoice = {
  provider: "anthropic",
  modelId: "claude-sonnet-5-5",
  credentialId: "c1",
};
const gemini: ModelRoleChoice = {
  provider: "google",
  modelId: "gemini-3.8-flash",
  credentialId: "g1",
};
const local: ModelRoleChoice = { provider: "local", modelId: "qwen3:4b", thinkingLevel: null };

describe("orderAutoPool", () => {
  it("runs each plan on its ladder's rung, the plan with most headroom first", () => {
    const ledger = new ModelQuotaLedger(() => 0);
    ledger.recordWindows("c1", [{ usedPercent: 80 }]);
    ledger.recordWindows("g1", [{ usedPercent: 10 }]);
    expect(orderAutoPool([claude, gemini], "high", { ledger })).toEqual([
      { provider: "google", modelId: "gemini-4-argon", credentialId: "g1", thinkingLevel: "high" },
      {
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        credentialId: "c1",
        thinkingLevel: "high",
      },
    ]);
  });

  it("books each pick so a burst spreads across plans", () => {
    const ledger = new ModelQuotaLedger(() => 0);
    ledger.recordWindows("c1", [{ usedPercent: 40 }]);
    ledger.recordWindows("g1", [{ usedPercent: 42 }]);
    const firsts = Array.from(
      { length: 3 },
      () => orderAutoPool([claude, gemini], "max", { ledger })[0]?.credentialId,
    );
    expect(firsts).toEqual(["c1", "g1", "c1"]);
  });

  it("keeps a model with no ladder, and lists each plan once", () => {
    const ledger = new ModelQuotaLedger(() => 0);
    const pool = [local, { ...claude, modelId: "claude-haiku-5-5" }, claude];
    const ordered = orderAutoPool(pool, "low", { ledger });
    expect(ordered).toHaveLength(2);
    expect(ordered.find((c) => c.provider === "local")).toMatchObject({
      modelId: "qwen3:4b",
      thinkingLevel: "low",
    });
    expect(planKey(local)).toBe("provider:local");
  });
});

describe("rateTaskEffort", () => {
  it("reads the rater's one-word reply and applies the size floor", async () => {
    expect(await rateTaskEffort("rename this", async () => "low")).toBe("low");
    expect(await rateTaskEffort("x".repeat(2000), async () => "Medium.")).toBe("high");
  });

  it("falls back to medium when the rating fails or is unreadable", async () => {
    expect(await rateTaskEffort("hi", async () => "I think it's easy")).toBe("medium");
    expect(
      await rateTaskEffort("hi", async () => {
        throw new Error("offline");
      }),
    ).toBe("medium");
  });

  it("sends the rubric and never more than 8,000 characters of the request", async () => {
    const rate = vi.fn(async () => "high");
    await rateTaskEffort("y".repeat(10_000), rate);
    const [instructions, prompt] = rate.mock.calls[0] as unknown as [string, string];
    expect(instructions).toMatch(/^Effort rubric v1/);
    expect(prompt).toHaveLength(8_000);
  });

  it("parses only the four levels", () => {
    expect(parseEffortRating("max")).toBe("max");
    expect(parseEffortRating("extreme")).toBeUndefined();
  });
});
