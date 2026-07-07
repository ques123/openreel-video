import { describe, expect, it } from "vitest";
import {
  generateTempPassword,
  hashToken,
  newId,
  newInviteCode,
  newSessionToken,
  normalizeInviteCode,
} from "./crypto-ids";
import { WIZZ_PASSWORD_MIN_LENGTH } from "@wizz/contracts";

describe("newId", () => {
  it("produces distinct UUID-shaped strings", () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("newSessionToken / hashToken", () => {
  it("produces a 64-char hex token (32 random bytes)", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces distinct tokens across calls", () => {
    expect(newSessionToken()).not.toBe(newSessionToken());
  });

  it("hashToken is deterministic (same input -> same hash) and 64-char hex (sha256)", () => {
    const token = newSessionToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashToken produces different hashes for different tokens", () => {
    expect(hashToken(newSessionToken())).not.toBe(hashToken(newSessionToken()));
  });
});

describe("newInviteCode", () => {
  it("matches the WZ-XXXX-XXXX shape", () => {
    expect(newInviteCode()).toMatch(/^WZ-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it("never contains the confusable characters 0, O, 1, I", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = newInviteCode();
      expect(code).not.toMatch(/[0O1I]/);
    }
  });

  it("produces distinct codes across calls", () => {
    const codes = new Set(Array.from({ length: 50 }, () => newInviteCode()));
    expect(codes.size).toBe(50);
  });
});

describe("normalizeInviteCode", () => {
  it("trims and uppercases user-typed input", () => {
    expect(normalizeInviteCode("  wz-7f3k-9mqr  ")).toBe("WZ-7F3K-9MQR");
  });
});

describe("generateTempPassword", () => {
  it("defaults to a length well above the minimum password length", () => {
    expect(generateTempPassword().length).toBeGreaterThanOrEqual(WIZZ_PASSWORD_MIN_LENGTH);
  });

  it("never contains the confusable characters 0, O, 1, I", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateTempPassword()).not.toMatch(/[0O1I]/);
    }
  });

  it("respects a custom length", () => {
    expect(generateTempPassword(8)).toHaveLength(8);
  });
});
