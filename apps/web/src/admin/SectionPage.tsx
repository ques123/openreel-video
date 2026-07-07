/**
 * Common chrome for an admin section: title + one-line description +
 * content, scrolling itself (`h-full overflow-y-auto`) rather than relying
 * on AdminShell's content pane to scroll — same convention PerceptionLabPage's
 * own root already uses.
 */
import type { ReactNode } from "react";

export function SectionPage({
  title,
  description,
  wide,
  children,
}: {
  title: string;
  description: ReactNode;
  /** Users/Usage/Presets/System all carry data-dense tables/forms that outgrow the original 4xl stub width; System's simpler layout can stay narrow. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className={`mx-auto p-6 ${wide ? "max-w-6xl" : "max-w-4xl"}`}>
        <h1 className="mb-2 text-xl font-semibold text-text-primary">{title}</h1>
        <p className="mb-4 text-sm text-text-secondary">{description}</p>
        {children}
      </div>
    </div>
  );
}
