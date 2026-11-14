import type { ConnectionHeadroom } from "./model-auto-route.js";

/** A limit the user set on a connection whose provider reports none. */
export interface ConnectionBudget {
  tokensPerDay?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface ConnectionState {
  coolingUntil: number;
  /** Last share of the provider's own limit it reported, and when that limit resets. */
  reported?: { remaining: number; resetAt: number };
  dayStart: number;
  dayTokens: number;
}

/**
 * What each model connection has spent and has left, as this process has seen it. Fed by every
 * call's reported usage, the provider's rate-limit headers, and 429 or usage-window errors.
 */
export class ModelQuotaLedger {
  private readonly connections = new Map<string, ConnectionState>();

  constructor(private readonly now: () => number = Date.now) {}

  private state(key: string): ConnectionState {
    let state = this.connections.get(key);
    const now = this.now();
    if (!state) {
      state = { coolingUntil: 0, dayStart: now, dayTokens: 0 };
      this.connections.set(key, state);
    }
    if (now - state.dayStart >= DAY_MS) {
      state.dayStart = now;
      state.dayTokens = 0;
    }
    return state;
  }

  /** Tokens one call used (input, cached input and output together). */
  recordUsage(key: string, tokens: number): void {
    if (tokens > 0) this.state(key).dayTokens += tokens;
  }

  /** Remaining share of the provider's limit, from its response headers. */
  recordReported(key: string, remaining: number, resetAt: number): void {
    this.state(key).reported = { remaining: Math.max(0, Math.min(1, remaining)), resetAt };
  }

  /** A rate limit or exhausted usage window: skip the connection until it clears. */
  coolDown(key: string, until: number): void {
    const state = this.state(key);
    state.coolingUntil = Math.max(state.coolingUntil, until);
  }

  headroom(key: string, budget?: ConnectionBudget): ConnectionHeadroom {
    const state = this.state(key);
    const now = this.now();
    const shares: number[] = [];
    if (state.reported && state.reported.resetAt > now) shares.push(state.reported.remaining);
    if (budget?.tokensPerDay && budget.tokensPerDay > 0) {
      shares.push(Math.max(0, 1 - state.dayTokens / budget.tokensPerDay));
    }
    const remaining = shares.length > 0 ? Math.min(...shares) : undefined;
    return {
      coolingDown: state.coolingUntil > now || remaining === 0,
      ...(remaining !== undefined ? { remaining } : {}),
    };
  }
}

/**
 * Header pairs that report a token or request limit and what is left of it. Providers without
 * any (Gemini, subscription sign-ins) rely on usage, budgets and 429s instead.
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

/** "1s", "6m0s", "250ms" (OpenAI) or an RFC 3339 time (Anthropic) to epoch milliseconds. */
function parseReset(value: string, now: number): number | undefined {
  const date = Date.parse(value);
  if (/^\d{4}-/.test(value) && Number.isFinite(date)) return date;
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of value.matchAll(pattern)) {
    matched = true;
    const n = Number(amount);
    total +=
      unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? now + total : undefined;
}

/** The tightest limit a response reports: its remaining share and when it resets. */
export function reportedHeadroom(
  headers: Headers,
  now: number,
): { remaining: number; resetAt: number } | undefined {
  let tightest: { remaining: number; resetAt: number } | undefined;
  for (const pair of LIMIT_HEADERS) {
    const limit = Number(headers.get(pair.limit));
    const remaining = Number(headers.get(pair.remaining));
    if (!(limit > 0) || !Number.isFinite(remaining)) continue;
    const resetAt = parseReset(headers.get(pair.reset) ?? "", now) ?? now + 60_000;
    const share = remaining / limit;
    if (!tightest || share < tightest.remaining) tightest = { remaining: share, resetAt };
  }
  return tightest;
}

/** When a 429 says to come back: Retry-After seconds or date, else a minute. */
export function retryAfterUntil(headers: Headers | undefined, now: number): number {
  const value = headers?.get("retry-after")?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return now + seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return now + 60_000;
}
