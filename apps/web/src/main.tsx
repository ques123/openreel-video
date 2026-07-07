/**
 * Entry point = target picker only. VITE_APP_TARGET is force-defined to a
 * literal in vite.config.ts, so exactly one of these branches survives in
 * each bundle and the other target's chunks are never emitted — the public
 * bundle physically contains no lab/experiments/perf code (WS-C acceptance),
 * and the admin bundle skips the public product. Keep this file free of any
 * app logic; the boots own their startup.
 */
import "./index.css";
import { IS_PUBLIC_TARGET } from "./app-target";

const root = document.getElementById("root")!;

if (IS_PUBLIC_TARGET) {
  void import("./publicapp/boot").then(({ bootPublic }) => bootPublic(root));
} else {
  void import("./boot-admin").then(({ bootAdmin }) => bootAdmin(root));
}
