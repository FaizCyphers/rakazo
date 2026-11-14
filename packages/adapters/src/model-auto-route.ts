import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import type { PlanHeadroom } from "./model-quota.js";

/** How hard a request is, rated before a run picks its model. Lowest that fits wins. */
export const TASK_EFFORTS = ["low", "medium", "high", "max"] as const;
export type TaskEffort = (typeof TASK_EFFORTS)[number];

/** One rung of a ladder: the model and thinking level a connection runs for an effort. */
export interface LadderRung {
  modelId: string;
  thinkingLevel: string;
}

export type EffortLadder = Record<TaskEffort, LadderRung>;

/**
 * Default ladders per provider: a light model for low effort up to the strongest model at its
 * highest thinking level for max. A connection can replace its provider's ladder.
 */
export const DEFAULT_EFFORT_LADDERS: Readonly<Record<string, EffortLadder>> = {
  anthropic: {
    low: { modelId: "claude-haiku-5-5", thinkingLevel: "low" },
    medium: { modelId: "claude-sonnet-5-5", thinkingLevel: "medium" },
    high: { modelId: "claude-opus-5-5", thinkingLevel: "high" },
    max: { modelId: "claude-opus-5-5", thinkingLevel: "max" },
  },
  "openai-codex": {
    low: { modelId: "gpt-6-luna", thinkingLevel: "low" },
    medium: { modelId: "gpt-6.1-sol", thinkingLevel: "medium" },
    high: { modelId: "gpt-6-astra", thinkingLevel: "high" },
    max: { modelId: "gpt-6-astra", thinkingLevel: "xhigh" },
  },
  google: {
    low: { modelId: "gemini-3.5-flash-lite", thinkingLevel: "low" },
    medium: { modelId: "gemini-3.8-flash", thinkingLevel: "medium" },
    high: { modelId: "gemini-4-argon", thinkingLevel: "high" },
    max: { modelId: "gemini-4-argon", thinkingLevel: "max" },
  },
};

/** A connected plan or key the router may pick, in the user's own order. */
export interface AutoRoutePlan {
  /** The connection; one usage reading and one cooldown per connection. */
  connectionKey: string;
  provider: string;
  ladder: EffortLadder;
}

export interface AutoRouteOptions {
  /** A plan used past this percent of any window is skipped while another has room. */
  hardLimitPercent?: number;
  /** Wins ties on headroom, and runs when no plan reports usage. */
  preferredConnectionKey?: string;
}

/** Why a plan was picked, recorded on the run. */
export type AutoRouteBasis = "usage" | "no-usage" | "only-option";

export interface AutoRoutePick {
  plan: AutoRoutePlan;
  rung: LadderRung;
  basis: AutoRouteBasis;
}

export const DEFAULT_HARD_LIMIT_PERCENT = 90;

/**
 * Orders the plans for one run: the first runs, the rest become its backups in order.
 *
 * Plans past the hard limit go behind the rest, and plans cooling down after a limit go last. The rest are ordered by
 * headroom (100 minus the most-used window), most first; a plan with no recent reading counts as
 * unknown and follows those with known room. Ties go to the preferred plan, then the user's order.
 * Every plan runs the rung of its own ladder for the effort.
 */
export function routeAutoModel(
  plans: readonly AutoRoutePlan[],
  effort: TaskEffort,
  headroom: (connectionKey: string) => PlanHeadroom,
  options: AutoRouteOptions = {},
): AutoRoutePick[] {
  const hardLimit = options.hardLimitPercent ?? DEFAULT_HARD_LIMIT_PERCENT;
  const ranked = plans.map((plan, order) => {
    const state = headroom(plan.connectionKey);
    // Over the hard limit can still answer; cooling down cannot.
    const blocked = state.coolingDown
      ? 2
      : state.usedPercent !== undefined && state.usedPercent >= hardLimit
        ? 1
        : 0;
    return {
      plan,
      order,
      blocked,
      known: state.usedPercent !== undefined,
      room: state.usedPercent === undefined ? 0 : 100 - state.usedPercent,
      preferred: plan.connectionKey === options.preferredConnectionKey,
    };
  });
  ranked.sort(
    (a, b) =>
      a.blocked - b.blocked ||
      Number(b.known) - Number(a.known) ||
      b.room - a.room ||
      Number(b.preferred) - Number(a.preferred) ||
      a.order - b.order,
  );
  const anyKnown = ranked.some((entry) => entry.known);
  return ranked.map(({ plan }) => ({
    plan,
    rung: plan.ladder[effort],
    basis: plans.length === 1 ? "only-option" : anyKnown ? "usage" : "no-usage",
  }));
}

/** Points a pick holds against its plan until the next usage reading, so bursts spread out. */
export const BOOKED_POINTS: Readonly<Record<TaskEffort, number>> = {
  low: 1,
  medium: 2,
  high: 4,
  max: 6,
};

/**
 * Raises a rated effort from the request's size: one level when it runs past 1,500 characters.
 * What the request means is rated by a model, never by keywords.
 */
export function effortFloor(rated: TaskEffort, characters: number): TaskEffort {
  const index = TASK_EFFORTS.indexOf(rated) + (characters > 1500 ? 1 : 0);
  return TASK_EFFORTS[Math.min(index, TASK_EFFORTS.length - 1)]!;
}

/** The rung's thinking level, clamped to what the model offers. */
export function rungThinkingLevel(model: Model<Api>, rung: LadderRung): string | null {
  if (!model.reasoning) return null;
  return clampCatalogThinkingLevel(
    rung.thinkingLevel,
    getSupportedThinkingLevels(model) as string[],
  );
}
