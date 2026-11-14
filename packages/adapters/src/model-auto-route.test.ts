import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import type { AutoRoutePlan } from "./model-auto-route.js";
import {
  BOOKED_POINTS,
  DEFAULT_EFFORT_LADDERS,
  effortFloor,
  routeAutoModel,
  rungThinkingLevel,
} from "./model-auto-route.js";
import type { PlanHeadroom } from "./model-quota.js";
import { headerUsageWindows, ModelQuotaLedger, retryAfterUntil } from "./model-quota.js";

const plan = (connectionKey: string, provider: string): AutoRoutePlan => ({
  connectionKey,
  provider,
  ladder: DEFAULT_EFFORT_LADDERS[provider]!,
});
const claude = plan("claude", "anthropic");
const chatgpt = plan("chatgpt", "openai-codex");
const gemini = plan("gemini", "google");
const plans = [claude, chatgpt, gemini];
const keys = (picks: ReturnType<typeof routeAutoModel>) => picks.map((p) => p.plan.connectionKey);

describe("DEFAULT_EFFORT_LADDERS", () => {
  it("names only catalog models", () => {
    const models = builtinModels();
    for (const [provider, ladder] of Object.entries(DEFAULT_EFFORT_LADDERS)) {
      for (const rung of Object.values(ladder)) {
        expect(models.getModel(provider, rung.modelId), `${provider}/${rung.modelId}`).toBeTruthy();
      }
    }
  });

  it("clamps a rung's thinking level to what the model offers", () => {
    const opus = builtinModels().getModel("anthropic", "claude-opus-5-5")!;
    expect(rungThinkingLevel(opus, DEFAULT_EFFORT_LADDERS.anthropic!.high)).toBe("high");
  });
});

describe("routeAutoModel", () => {
  it("runs each plan's own rung for the effort", () => {
    const [pick] = routeAutoModel([chatgpt], "high", () => ({ coolingDown: false }));
    expect(pick).toMatchObject({ rung: { modelId: "gpt-6-astra" }, basis: "only-option" });
  });

  it("picks the plan with the most headroom, the rest in order as backups", () => {
    const used: Record<string, number> = { claude: 70, chatgpt: 20, gemini: 45 };
    const picks = routeAutoModel(plans, "medium", (key) => ({
      coolingDown: false,
      usedPercent: used[key],
    }));
    expect(keys(picks)).toEqual(["chatgpt", "gemini", "claude"]);
    expect(picks[0]?.basis).toBe("usage");
  });

  it("skips plans past the hard limit or cooling down, and puts unknown usage after known", () => {
    const state: Record<string, PlanHeadroom> = {
      claude: { coolingDown: false, usedPercent: 92 },
      chatgpt: { coolingDown: true, usedPercent: 10 },
      gemini: { coolingDown: false },
    };
    expect(keys(routeAutoModel(plans, "low", (key) => state[key]!))).toEqual([
      "gemini",
      "claude",
      "chatgpt",
    ]);
    const known: Record<string, PlanHeadroom> = {
      ...state,
      claude: { coolingDown: false, usedPercent: 50 },
    };
    expect(keys(routeAutoModel(plans, "low", (key) => known[key]!))[0]).toBe("claude");
  });

  it("breaks ties with the preferred plan, then the user's order", () => {
    const even = () => ({ coolingDown: false });
    expect(keys(routeAutoModel(plans, "low", even))[0]).toBe("claude");
    expect(keys(routeAutoModel(plans, "low", even, { preferredConnectionKey: "gemini" }))[0]).toBe(
      "gemini",
    );
  });

  it("raises effort for a long request", () => {
    expect(effortFloor("medium", 400)).toBe("medium");
    expect(effortFloor("medium", 2000)).toBe("high");
    expect(effortFloor("max", 2000)).toBe("max");
  });
});

describe("ModelQuotaLedger", () => {
  it("reads the most-used window and adds picks booked since", () => {
    let now = 0;
    const ledger = new ModelQuotaLedger(() => now);
    ledger.recordWindows("chatgpt", [
      { usedPercent: 30, resetsAt: 5 * 3_600_000 },
      { usedPercent: 55, resetsAt: 7 * 24 * 3_600_000 },
    ]);
    ledger.book("chatgpt", BOOKED_POINTS.high);
    expect(ledger.headroom("chatgpt")).toEqual({ coolingDown: false, usedPercent: 59 });
    // A new reading replaces the bookings.
    ledger.recordWindows("chatgpt", [{ usedPercent: 60 }]);
    expect(ledger.headroom("chatgpt").usedPercent).toBe(60);
    // Stale after 30 minutes.
    now += 30 * 60 * 1000;
    expect(ledger.headroom("chatgpt").usedPercent).toBeUndefined();
  });

  it("cools a spent plan down until its window resets", () => {
    let now = 0;
    const ledger = new ModelQuotaLedger(() => now);
    ledger.recordWindows("claude", [{ usedPercent: 100, resetsAt: 2 * 3_600_000 }]);
    expect(ledger.headroom("claude").coolingDown).toBe(true);
    now = 2 * 3_600_000 + 1;
    expect(ledger.headroom("claude").coolingDown).toBe(false);
  });

  it("cools down after a 429 for its Retry-After, or a minute", () => {
    let now = 1_000;
    const ledger = new ModelQuotaLedger(() => now);
    ledger.coolDown("o", retryAfterUntil(new Headers({ "retry-after": "30" }), now));
    expect(ledger.headroom("o").coolingDown).toBe(true);
    now += 30_001;
    expect(ledger.headroom("o").coolingDown).toBe(false);
    ledger.coolDown("o");
    now += 59_000;
    expect(ledger.headroom("o").coolingDown).toBe(true);
  });

  it("tracks a daily token budget for plans that report nothing", () => {
    let now = 0;
    const ledger = new ModelQuotaLedger(() => now);
    ledger.recordUsage("g", 900);
    expect(ledger.headroom("g", { tokensPerDay: 1000 }).usedPercent).toBe(90);
    ledger.recordUsage("g", 200);
    expect(ledger.headroom("g", { tokensPerDay: 1000 })).toEqual({
      coolingDown: true,
      usedPercent: 100,
    });
    now += 24 * 60 * 60 * 1000;
    expect(ledger.headroom("g", { tokensPerDay: 1000 }).usedPercent).toBe(0);
  });

  it("turns rate-limit headers into usage windows", () => {
    expect(
      headerUsageWindows(
        new Headers({
          "x-ratelimit-limit-tokens": "1000",
          "x-ratelimit-remaining-tokens": "250",
          "x-ratelimit-reset-tokens": "6m0s",
          "anthropic-ratelimit-requests-limit": "100",
          "anthropic-ratelimit-requests-remaining": "90",
          "anthropic-ratelimit-requests-reset": "1970-01-01T00:01:00Z",
        }),
        0,
      ),
    ).toEqual([
      { usedPercent: 75, resetsAt: 360_000 },
      { usedPercent: 10, resetsAt: 60_000 },
    ]);
  });
});
