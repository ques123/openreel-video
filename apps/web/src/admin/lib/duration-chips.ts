/**
 * Pure reducer for the Presets editor's duration-chips list
 * (PublishedPreset.targetDurationChoicesS): a deduped, ascending-sorted list
 * of positive-integer seconds, edited via add/remove actions from the chip
 * row + "add" number input.
 */
export type DurationChipsAction = { type: "add"; seconds: number } | { type: "remove"; seconds: number };

export function durationChipsReducer(state: readonly number[], action: DurationChipsAction): number[] {
  if (action.type === "remove") {
    return state.filter((s) => s !== action.seconds);
  }
  const seconds = Math.round(action.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return [...state];
  if (state.includes(seconds)) return [...state];
  return [...state, seconds].sort((a, b) => a - b);
}
