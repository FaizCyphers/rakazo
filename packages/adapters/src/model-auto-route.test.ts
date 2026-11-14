import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AutoRouteCandidate, ConnectionHeadroom } from "./model-auto-route.js";
import { routeAutoModel, thinkingForEffort, tierPool } from "./model-auto-route.js";
import { ModelQuotaLedger, reportedHeadroom, retryAfterUntil } from "./model-quota.js";

function model(id: string, input: number, output: number, reasoning = true): Model<Api> {
  return {
    provider: "fixture",
    id,
    api: "openai-responses",
    name: id,
    baseUrl: "https://model.example.test",
    reasoning,
    thinkingLevelMap: reasoning
      ? { minimal: "minimal", low: "low", medium: "medium", high: "high" }
      : undefined,
    input: ["text"],
    cost: { input, output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  } as Model<Api>;
}

const cheap: AutoRouteCandidate = { connectionKey: "a", model: model("cheap", 0.1, 0.4) };
const mid: AutoRouteCandidate = { connectionKey: "b", model: model("mid", 1, 4) };
const strong: AutoRouteCandidate = { connectionKey: "c", model: model("strong", 5, 25) };
const pool = [strong, mid, cheap];
const open = (): ConnectionHeadroom => ({ coolingDown: false });
const ids = (picks: ReturnType<typeof routeAutoModel>) => picks.map((p) => p.candidate.model.id);

describe("tierPool", () => {
  it("splits the connected models by price", () => {
    const tiers = tierPool(pool);
    expect([tiers.get(cheap), tiers.get(mid), tiers.get(strong)]).toEqual([
      "light",
      "standard",
      "strong",
    ]);
  });

  it("treats unpriced models as standard and never calls a non-reasoning model strong", () => {
    const local: AutoRouteCandidate = { connectionKey: "l", model: model("local", 0, 0) };
    const plain: AutoRouteCandidate = { connectionKey: "p", model: model("plain", 9, 30, false) };
    const tiers = tierPool([cheap, local, plain]);
    expect(tiers.get(local)).toBe("standard");
    expect(tiers.get(plain)).toBe("standard");
    expect(tiers.get(cheap)).toBe("light");
  });
});

describe("routeAutoModel", () => {
  it("sends each effort to the matching tier and keeps the rest as backups", () => {
    expect(ids(routeAutoModel(pool, "low", open))).toEqual(["cheap", "mid", "strong"]);
    expect(ids(routeAutoModel(pool, "medium", open))).toEqual(["mid", "strong", "cheap"]);
    expect(ids(routeAutoModel(pool, "high", open))).toEqual(["strong", "mid", "cheap"]);
  });

  it("sets thinking from effort", () => {
    const [low] = routeAutoModel(pool, "low", open);
    const [high] = routeAutoModel(pool, "high", open);
    expect(low?.thinkingLevel).toBe("minimal");
    expect(high?.thinkingLevel).toBe("high");
    expect(thinkingForEffort(model("plain", 1, 1, false), "high")).toBeNull();
  });

  it("moves connections that are cooling down or nearly spent behind the rest", () => {
    const headroom = (key: string): ConnectionHeadroom =>
      key === "c"
        ? { coolingDown: true }
        : key === "b"
          ? { coolingDown: false, remaining: 0.05 }
          : open();
    expect(ids(routeAutoModel(pool, "high", headroom))).toEqual(["cheap", "mid", "strong"]);
  });

  it("prefers more headroom within a tier, then the user's order", () => {
    const twin: AutoRouteCandidate = { connectionKey: "d", model: model("twin", 5, 25) };
    const headroom = (key: string): ConnectionHeadroom =>
      key === "c" ? { coolingDown: false, remaining: 0.4 } : open();
    expect(ids(routeAutoModel([strong, twin, cheap], "high", headroom))[0]).toBe("twin");
    expect(ids(routeAutoModel([strong, twin, cheap], "high", open))[0]).toBe("strong");
  });
});

describe("ModelQuotaLedger", () => {
  it("tracks a daily token budget and resets it after a day", () => {
    let now = 0;
    const ledger = new ModelQuotaLedger(() => now);
    ledger.recordUsage("g", 900);
    expect(ledger.headroom("g", { tokensPerDay: 1000 }).remaining).toBeCloseTo(0.1);
    ledger.recordUsage("g", 200);
    expect(ledger.headroom("g", { tokensPerDay: 1000 })).toEqual({
      coolingDown: true,
      remaining: 0,
    });
    now += 24 * 60 * 60 * 1000;
    expect(ledger.headroom("g", { tokensPerDay: 1000 })).toEqual({
      coolingDown: false,
      remaining: 1,
    });
  });

  it("cools a connection down until its retry time", () => {
    let now = 1_000;
    const ledger = new ModelQuotaLedger(() => now);
    ledger.coolDown("o", retryAfterUntil(new Headers({ "retry-after": "30" }), now));
    expect(ledger.headroom("o").coolingDown).toBe(true);
    now += 30_001;
    expect(ledger.headroom("o").coolingDown).toBe(false);
  });

  it("uses the provider's reported limit until it resets", () => {
    let now = 0;
    const ledger = new ModelQuotaLedger(() => now);
    const reported = reportedHeadroom(
      new Headers({
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "250",
        "x-ratelimit-reset-tokens": "6m0s",
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "90",
      }),
      now,
    );
    expect(reported).toEqual({ remaining: 0.25, resetAt: 360_000 });
    ledger.recordReported("o", reported!.remaining, reported!.resetAt);
    expect(ledger.headroom("o").remaining).toBe(0.25);
    now = 360_000;
    expect(ledger.headroom("o").remaining).toBeUndefined();
  });

  it("reads Anthropic-style reset times", () => {
    const reported = reportedHeadroom(
      new Headers({
        "anthropic-ratelimit-tokens-limit": "400",
        "anthropic-ratelimit-tokens-remaining": "100",
        "anthropic-ratelimit-tokens-reset": "2026-01-01T00:01:00Z",
      }),
      Date.parse("2026-01-01T00:00:00Z"),
    );
    expect(reported).toEqual({ remaining: 0.25, resetAt: Date.parse("2026-01-01T00:01:00Z") });
  });
});
