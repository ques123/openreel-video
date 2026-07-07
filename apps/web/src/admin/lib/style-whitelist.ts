/**
 * Pure ordering helper for the Presets editor's style-whitelist checkboxes.
 * Checkboxes render in the full STYLE_PRESETS catalog's fixed order
 * (@openreel/core, 11 authored voices), but the SAVED whitelist array is an
 * ORDERED list (contracts.ts: "StylePreset ids ... in display order" — the
 * order the public product shows style chips in). Toggling a checkbox must
 * never reshuffle ids that are already checked: a newly-checked id is
 * appended at the end; unchecking removes it without touching the relative
 * order of what remains.
 */

/**
 * `checked=true` appends `id` at the end of `current` (a no-op if it's
 * already present — defensive against a double-fire, never duplicates or
 * reorders). `checked=false` removes it, preserving the order of the rest.
 */
export function toggleStyleWhitelistId(current: readonly string[], id: string, checked: boolean): string[] {
  const withoutId = current.filter((existing) => existing !== id);
  if (!checked) return withoutId;
  if (current.includes(id)) return [...current];
  return [...withoutId, id];
}
