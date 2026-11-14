/** One usage window a plan reports, such as a five-hour session or a weekly allowance. */
export interface UsageWindow {
  /** 0 to 100. */
  usedPercent: number;
  /** Epoch milliseconds; undefined when the provider does not say. */
  resetsAt?: number;
}

/** What the router knows about a plan right now. */
export interface PlanHeadroom {
  /** True while a rate limit or exhausted window is cooling down. */
  coolingDown: boolean;
  /** The most-used window plus picks booked since the reading; undefined when unknown. */
  usedPercent?: number;
}

/** A limit the user set on a connection whose provider reports none. */
export interface ConnectionBudget {
  tokensPerDay?: number;
}

/** Readings older than this count as unknown. */
export const USAGE_STALE_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60_000;

interface PlanState {
  reading?: { windows: UsageWindow[]; readAt: number };
  /** Points booked by picks since the last reading, as percent of the plan. */
  booked: number;
  coolingUntil: number;
  dayStart: number;
  dayTokens: number;
}

/**
 * Each plan's usage as this process has seen it: readings of its usage windows, picks booked
 * since, token spend against a user budget, and cooldowns after a limit. A cooldown lasts until the
 * window that ran out resets, so a spent plan is not tried again before it can answer.
 */
export class ModelQuotaLedger {
  private readonly plans = new Map<string, PlanState>();

  constructor(private readonly now: () => number = Date.now) {}

  private state(key: string): PlanState {
    const now = this.now();
    let state = this.plans.get(key);
    if (!state) {
      state = { booked: 0, coolingUntil: 0, dayStart: now, dayTokens: 0 };
      this.plans.set(key, state);
    }
    if (now - state.dayStart >= DAY_MS) {
      state.dayStart = now;
      state.dayTokens = 0;
    }
    return state;
  }

  /** A fresh reading replaces the last one and clears what was booked against it. */
  recordWindows(key: string, windows: UsageWindow[]): void {
    const state = this.state(key);
    state.reading = { windows, readAt: this.now() };
    state.booked = 0;
    const spent = windows.filter((window) => window.usedPercent >= 100);
    if (spent.length > 0) {
      this.coolDown(key, Math.max(...spent.map((window) => window.resetsAt ?? 0)));
    }
  }

  /** Holds a pick's share against the plan until the next reading. */
  book(key: string, points: number): void {
    this.state(key).booked += points;
  }

  /** Tokens one call used, against the connection's own budget. */
  recordUsage(key: string, tokens: number): void {
    if (tokens > 0) this.state(key).dayTokens += tokens;
  }

  /** A rate limit or exhausted window: skip the plan until it resets (a minute if unknown). */
  coolDown(key: string, until?: number): void {
    const state = this.state(key);
    const at = until && until > this.now() ? until : this.now() + DEFAULT_COOLDOWN_MS;
    state.coolingUntil = Math.max(state.coolingUntil, at);
  }

  headroom(key: string, budget?: ConnectionBudget): PlanHeadroom {
    const state = this.state(key);
    const now = this.now();
    const used: number[] = [];
    const reading = state.reading;
    if (reading && now - reading.readAt < USAGE_STALE_MS) {
      for (const window of reading.windows) {
        if (window.resetsAt === undefined || window.resetsAt > now) used.push(window.usedPercent);
      }
      if (used.length > 0) used.push(Math.max(...used) + state.booked);
    }
    if (budget?.tokensPerDay && budget.tokensPerDay > 0) {
      used.push((100 * state.dayTokens) / budget.tokensPerDay);
    }
    const usedPercent = used.length > 0 ? Math.min(100, Math.max(...used)) : undefined;
    return {
      coolingDown: state.coolingUntil > now || usedPercent === 100,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
    };
  }
}

/**
 * Header pairs that report a key's token or request limit and what is left of it. Subscription
 * sign-ins report their windows through the provider's usage endpoint instead.
 */
const LIMIT_HEADERS: ReadonlyArray<{ limit: string; remaining: string; reset: string }> = [
  {
    limit: "x-ratelimit-limit-tokens",
    remaining: "x-ratelimit-remaining-tokens",
    reset: "x-ratelimit-reset-tokens",
  },
  {
    limit: "x-ratelimit-limit-requests",
    remaining: "x-ratelimit-remaining-requests",
    reset: "x-ratelimit-reset-requests",
  },
  {
    limit: "anthropic-ratelimit-tokens-limit",
    remaining: "anthropic-ratelimit-tokens-remaining",
    reset: "anthropic-ratelimit-tokens-reset",
  },
  {
    limit: "anthropic-ratelimit-requests-limit",
    remaining: "anthropic-ratelimit-requests-remaining",
    reset: "anthropic-ratelimit-requests-reset",
  },
];

/** "1s", "6m0s", "250ms" or an RFC 3339 time, to epoch milliseconds. */
function parseReset(value: string, now: number): number | undefined {
  if (/^\d{4}-/.test(value)) {
    const date = Date.parse(value);
    return Number.isFinite(date) ? date : undefined;
  }
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(amount);
    total +=
      unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? now + total : undefined;
}

/** The usage windows a response's rate-limit headers report. */
export function headerUsageWindows(headers: Headers, now: number): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const pair of LIMIT_HEADERS) {
    const limit = Number(headers.get(pair.limit));
    const remaining = Number(headers.get(pair.remaining));
    if (!(limit > 0) || headers.get(pair.remaining) === null || !Number.isFinite(remaining)) {
      continue;
    }
    windows.push({
      usedPercent: Math.max(0, Math.min(100, (100 * (limit - remaining)) / limit)),
      resetsAt: parseReset(headers.get(pair.reset) ?? "", now),
    });
  }
  return windows;
}

/** When a 429 says to come back: Retry-After seconds or date. */
export function retryAfterUntil(headers: Headers | undefined, now: number): number | undefined {
  const value = headers?.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}
