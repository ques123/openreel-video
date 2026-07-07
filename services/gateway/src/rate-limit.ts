/**
 * In-memory sliding-window rate limiter. One instance per limited surface
 * (login/IP, proxy/user, proxy/IP, telemetry/user — see RATE_LIMITS in
 * @wizz/contracts plus the login-specific 10/min/IP from contracts §2, which
 * isn't in that constant since it's an auth-route concern, not a proxy one).
 *
 * A true sliding window (timestamp log per key, not fixed buckets) so
 * boundary behavior is exact and trivially testable with fake timers.
 */

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the oldest hit in the current window falls out of it — only meaningful when !ok. */
  retryAfterS: number;
}

export class RateLimiter {
  #hits = new Map<string, number[]>();
  #lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit for `key` at `now` and reports whether it's within the limit. Always records — including rejected hits — so a caller hammering the endpoint doesn't get a longer effective window. */
  check(key: string, now: number = Date.now()): RateLimitResult {
    const cutoff = now - this.windowMs;
    const existing = this.#hits.get(key) ?? [];
    const kept = existing.filter((t) => t > cutoff);

    if (kept.length >= this.limit) {
      this.#hits.set(key, kept);
      const retryAfterS = Math.max(1, Math.ceil((kept[0] + this.windowMs - now) / 1000));
      return { ok: false, retryAfterS };
    }

    kept.push(now);
    this.#hits.set(key, kept);
    this.#maybeSweep(now);
    return { ok: true, retryAfterS: 0 };
  }

  /** Periodic cleanup of keys with no hits left in-window, so long uptimes with many distinct users/IPs don't leak memory. */
  #maybeSweep(now: number): void {
    if (now - this.#lastSweep < this.windowMs) return;
    this.#lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, hits] of this.#hits) {
      const kept = hits.filter((t) => t > cutoff);
      if (kept.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, kept);
    }
  }

  /** Test/inspection helper. */
  size(): number {
    return this.#hits.size;
  }
}

const ONE_MINUTE_MS = 60_000;

/** Login is 10/min/IP per contracts §2 (auth-route specific — not part of the shared RATE_LIMITS constant). */
export const LOGIN_RATE_LIMIT_PER_IP = 10;

export function createLoginLimiter(): RateLimiter {
  return new RateLimiter(LOGIN_RATE_LIMIT_PER_IP, ONE_MINUTE_MS);
}

export function createRateLimiter(limitPerMinute: number): RateLimiter {
  return new RateLimiter(limitPerMinute, ONE_MINUTE_MS);
}
