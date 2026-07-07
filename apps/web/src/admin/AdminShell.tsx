/**
 * Admin shell — sidebar + content frame for the wizz admin build target
 * (today's app plus Users/Usage/Presets/System; see docs/wizz-video-plan.md
 * §WS-C and docs/wizz-contracts.md §0/§8). This is the ADMIN surface, not
 * the public wizz.video product: it deliberately reuses the existing app's
 * utilitarian Tailwind idioms (bg-background, text-text-*, border-border —
 * the same tokens PerceptionLabPage and its panels already use) and does
 * NOT import styles/wizz-tokens.css, which styles the public product only.
 *
 * #/lab mounts today's PerceptionLabPage completely unchanged (same
 * component, same props) inside the content pane. The pane fills whatever
 * height its parent gives it (App.tsx's existing `h-screen` wrapper) via
 * `h-full`, mirroring PerceptionLabPage's own root
 * (`h-full overflow-y-auto`) so nesting introduces no double scroll
 * container: the lab keeps managing its own vertical scroll exactly as
 * before, the shell just adds a sidebar beside it.
 */
import type { ReactNode } from "react";
import { ADMIN_ROUTES } from "@wizz/contracts";

export type AdminSection = "lab" | "users" | "usage" | "presets" | "system";

interface NavItem {
  section: AdminSection;
  label: string;
  href: string;
}

const NAV_ITEMS: NavItem[] = [
  { section: "lab", label: "Perception Lab", href: ADMIN_ROUTES.lab },
  { section: "users", label: "Users", href: ADMIN_ROUTES.users },
  { section: "usage", label: "Usage & Spend", href: ADMIN_ROUTES.usage },
  { section: "presets", label: "Presets", href: ADMIN_ROUTES.presets },
  { section: "system", label: "System", href: ADMIN_ROUTES.system },
];

export function AdminShell({
  section,
  children,
}: {
  section: AdminSection;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-text-primary">
      <nav className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-background-secondary">
        <div className="border-b border-border px-4 py-4">
          <span className="text-sm font-semibold tracking-wide text-text-primary">
            wizz admin
          </span>
        </div>
        <ul className="flex-1 overflow-y-auto py-2">
          {NAV_ITEMS.map((item) => {
            const active = item.section === section;
            return (
              <li key={item.section}>
                <a
                  href={item.href}
                  className={
                    "block border-l-2 px-4 py-2 text-sm transition-colors " +
                    (active
                      ? "border-primary bg-background-tertiary text-text-primary"
                      : "border-transparent text-text-secondary hover:bg-background-tertiary hover:text-text-primary")
                  }
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="h-full min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
