/**
 * Barrel for the admin shell + Wave-2 section stubs, so App.tsx (the only
 * consumer outside this directory) gets a single import line.
 */
export { AdminShell, type AdminSection } from "./AdminShell";
export { UsersSection } from "./sections/UsersSection";
export { UsageSection } from "./sections/UsageSection";
export { PresetsSection } from "./sections/PresetsSection";
export { SystemSection } from "./sections/SystemSection";
