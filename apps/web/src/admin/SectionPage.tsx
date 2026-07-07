/**
 * Common chrome for a Wave-2 admin section stub: title + one-line
 * description + content, scrolling itself (`h-full overflow-y-auto`) rather
 * than relying on AdminShell's content pane to scroll — same convention
 * PerceptionLabPage's own root already uses.
 */
import type { ReactNode } from "react";

export function SectionPage({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-4xl p-6">
        <h1 className="mb-2 text-xl font-semibold text-text-primary">{title}</h1>
        <p className="mb-4 text-sm text-text-secondary">{description}</p>
        {children}
      </div>
    </div>
  );
}
