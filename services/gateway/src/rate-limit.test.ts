import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows up to the limit within the window, then rejects", () => {
    const rl = new RateLimiter(3, 60_000);
    const now = 1_000_000;
    expect(rl.check("k", now).ok).toBe(true);
    expect(rl.check("k", now + 1).ok).toBe(true);
    expect(rl.check("k", now + 2).ok).toBe(true);
    expect(rl.check("k", now + 3).ok).toBe(false);
  });

  it("tracks separate keys independently", () => {
    const rl = new RateLimiter(1, 60_000);
    const now = 1_000_000;
    expect(rl.check("a", now).ok).toBe(true);
    expect(rl.check("b", now).ok).toBe(true); // different key, unaffected by "a"'s hit
    expect(rl.check("a", now + 1).ok).toBe(false);
  });

  it("a hit that ages out of the window frees up capacity", () => {
    const rl = new RateLimiter(1, 60_000);
    const now = 1_000_000;
    expect(rl.check("k", now).ok).toBe(true);
    expect(rl.check("k", now + 60_000 - 1).ok).toBe(false); // still within the window
    expect(rl.check("k", now + 60_000 + 1).ok).toBe(true); // now outside the window
  });

  it("retryAfterS is a positive integer bounding when the oldest hit falls out of the window", () => {
    const rl = new RateLimiter(1, 60_000);
    const now = 1_000_000;
    rl.check("k", now);
    const result = rl.check("k", now + 10_000);
    expect(result.ok).toBe(false);
    expect(result.retryAfterS).toBe(50); // 60_000 - 10_000 = 50_000ms -> 50s
  });

  it("rejected attempts aren't added to the log, so hammering doesn't push out the reset time", () => {
    const rl = new RateLimiter(1, 60_000);
    const now = 1_000_000;
    rl.check("k", now); // the one allowed hit
    rl.check("k", now + 1); // rejected
    const hammered = rl.check("k", now + 30_000); // rejected again, later
    expect(hammered.ok).toBe(false);
    expect(hammered.retryAfterS).toBe(30); // still measured from the original hit at `now`, not from the rejections
    expect(rl.check("k", now + 60_000 + 1).ok).toBe(true); // window opens up right on schedule
  });
});
