import { describe, expect, it } from "vitest";
import { durationChipsReducer } from "./duration-chips";

describe("durationChipsReducer", () => {
  it("adds a new chip", () => {
    expect(durationChipsReducer([30, 60], { type: "add", seconds: 90 })).toEqual([30, 60, 90]);
  });

  it("keeps the list sorted ascending regardless of insertion order", () => {
    let state = durationChipsReducer([], { type: "add", seconds: 90 });
    state = durationChipsReducer(state, { type: "add", seconds: 30 });
    state = durationChipsReducer(state, { type: "add", seconds: 60 });
    expect(state).toEqual([30, 60, 90]);
  });

  it("dedupes an already-present value", () => {
    expect(durationChipsReducer([30, 60], { type: "add", seconds: 30 })).toEqual([30, 60]);
  });

  it("rounds a fractional seconds value", () => {
    expect(durationChipsReducer([], { type: "add", seconds: 59.6 })).toEqual([60]);
  });

  it("ignores a non-positive add", () => {
    expect(durationChipsReducer([30], { type: "add", seconds: 0 })).toEqual([30]);
    expect(durationChipsReducer([30], { type: "add", seconds: -5 })).toEqual([30]);
  });

  it("ignores a non-finite add", () => {
    expect(durationChipsReducer([30], { type: "add", seconds: NaN })).toEqual([30]);
  });

  it("removes an exact match", () => {
    expect(durationChipsReducer([30, 60, 90], { type: "remove", seconds: 60 })).toEqual([30, 90]);
  });

  it("removing a value not present is a no-op", () => {
    expect(durationChipsReducer([30, 60], { type: "remove", seconds: 999 })).toEqual([30, 60]);
  });

  it("never mutates the input array", () => {
    const state = [30, 60];
    const result = durationChipsReducer(state, { type: "add", seconds: 90 });
    expect(result).not.toBe(state);
    expect(state).toEqual([30, 60]);
  });
});
