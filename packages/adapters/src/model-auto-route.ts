import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { clampCatalogThinkingLevel } from "@rakazo/core";

/** How hard a request is, as rated before a run picks its model. */
export type TaskEffort = "low" | "medium" | "high";

/** Relative strength of a model within one pool, from what it costs and whether it reasons. */
export type ModelTier = "light" | "standard" | "strong";

const TIER_ORDER: readonly ModelTier[] = ["light", "standard", "strong"];
const EFFORT_TIER: Record<TaskEffort, ModelTier> = {
  low: "light",
  medium: "standard",
  high: "strong",
};
const EFFORT_THINKING: Record<TaskEffort, string> = {
  low: "minimal",
  medium: "medium",
  high: "high",
};

/** A connected model the router may pick, in the user's own order. */
export interface AutoRouteCandidate {
  /** The connection that would run it; one budget and one cooldown per connection. */
  connectionKey: string;
  model: Model<Api>;
}

export interface AutoRoutePick {
  candidate: AutoRouteCandidate;
  tier: ModelTier;
  /** Null lets the model's own default apply. */
  thinkingLevel: string | null;
}

/** Blended price per million tokens, weighting output like a typical agent turn (1 out : 3 in). */
function blendedPrice(model: Model<Api>): number | undefined {
  const { input, output } = model.cost;
  if (!(input > 0) && !(output > 0)) return undefined;
  return (3 * input + output) / 4;
}

/**
 * Tiers models by price within the pool, so the split follows what the user actually connected:
 * the cheapest third is light, the dearest third strong. Unpriced models (local, subscriptions)
 * count as standard, and a model that cannot reason is never strong.
 */
export function tierPool(pool: readonly AutoRouteCandidate[]): Map<AutoRouteCandidate, ModelTier> {
  const priced = pool
    .map((candidate) => ({ candidate, price: blendedPrice(candidate.model) }))
    .filter(
      (entry): entry is { candidate: AutoRouteCandidate; price: number } =>
        entry.price !== undefined,
    )
    .sort((a, b) => a.price - b.price);
  const tiers = new Map<AutoRouteCandidate, ModelTier>();
  const distinct = [...new Set(priced.map((entry) => entry.price))];
  for (const { candidate, price } of priced) {
    let tier: ModelTier = "standard";
    if (distinct.length >= 2) {
      const rank = distinct.indexOf(price) / (distinct.length - 1);
      tier = rank < 1 / 3 ? "light" : rank > 2 / 3 ? "strong" : "standard";
      if (distinct.length === 2) tier = rank === 0 ? "light" : "strong";
    }
    tiers.set(candidate, tier);
  }
  for (const candidate of pool) if (!tiers.has(candidate)) tiers.set(candidate, "standard");
  for (const [candidate, tier] of tiers) {
    if (tier === "strong" && !candidate.model.reasoning) tiers.set(candidate, "standard");
  }
  return tiers;
}

/** What a connection has left, as far as the router knows. */
export interface ConnectionHeadroom {
  /** True while a rate limit or usage window is cooling down. */
  coolingDown: boolean;
  /** Share of the known limit still free, 0 to 1; undefined when no limit is known. */
  remaining?: number;
}

/** Below this share of a known limit, a connection is kept for when nothing else is left. */
export const LOW_HEADROOM = 0.1;

/**
 * Orders the pool for one run: the first entry runs, the rest become its backups.
 * Connections cooling down go last. Among the rest, the lowest tier that fits the effort comes
 * first, then stronger tiers, then weaker ones; within a tier, more headroom first, then the
 * user's order. A connection nearly out of its limit drops behind every one that is not.
 */
export function routeAutoModel(
  pool: readonly AutoRouteCandidate[],
  effort: TaskEffort,
  headroom: (connectionKey: string) => ConnectionHeadroom,
): AutoRoutePick[] {
  const tiers = tierPool(pool);
  const wanted = TIER_ORDER.indexOf(EFFORT_TIER[effort]);
  const tierRank = (tier: ModelTier) => {
    const index = TIER_ORDER.indexOf(tier);
    // Stronger than needed beats weaker than needed: an underpowered model fails the task.
    return index >= wanted ? index - wanted : TIER_ORDER.length + (wanted - index);
  };
  const bucket = (state: ConnectionHeadroom) =>
    state.coolingDown ? 2 : state.remaining !== undefined && state.remaining < LOW_HEADROOM ? 1 : 0;
  const ranked = pool.map((candidate, order) => {
    const state = headroom(candidate.connectionKey);
    const tier = tiers.get(candidate) ?? "standard";
    return { candidate, order, tier, bucket: bucket(state), remaining: state.remaining ?? 1 };
  });
  ranked.sort(
    (a, b) =>
      a.bucket - b.bucket ||
      tierRank(a.tier) - tierRank(b.tier) ||
      b.remaining - a.remaining ||
      a.order - b.order,
  );
  return ranked.map(({ candidate, tier }) => ({
    candidate,
    tier,
    thinkingLevel: thinkingForEffort(candidate.model, effort),
  }));
}

/** The thinking level that matches an effort, clamped to what the model offers. */
export function thinkingForEffort(model: Model<Api>, effort: TaskEffort): string | null {
  if (!model.reasoning) return null;
  return clampCatalogThinkingLevel(
    EFFORT_THINKING[effort],
    getSupportedThinkingLevels(model) as string[],
  );
}
