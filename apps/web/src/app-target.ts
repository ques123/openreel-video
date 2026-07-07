/**
 * Which app this bundle is: "public" = the wizz.video product (generate flow
 * + editor, auth-gated), "admin" = today's full app wrapped in the admin
 * shell (lab, users, usage, presets, system). Defaults to "admin" so every
 * existing dev/build workflow behaves exactly as before this file existed.
 *
 * Vite replaces import.meta.env.VITE_APP_TARGET with a literal at build time,
 * so `if (IS_PUBLIC_TARGET)` branches are statically dead in the other
 * target's bundle and rollup drops their dynamic imports entirely — that is
 * the mechanism behind "the public bundle contains no lab code" (WS-C
 * verifies via bundle grep, not hidden routes).
 */
export const APP_TARGET: "public" | "admin" =
  import.meta.env.VITE_APP_TARGET === "public" ? "public" : "admin";

export const IS_PUBLIC_TARGET = import.meta.env.VITE_APP_TARGET === "public";
