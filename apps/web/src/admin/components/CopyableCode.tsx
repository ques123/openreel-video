/**
 * A monospace value with a copy-to-clipboard button, used wherever the admin
 * gets a secret/code back from a mutation: invite codes (persist forever in
 * the invites list, so no "once" warning) and reset-password temp passwords
 * (hashed server-side and never retrievable again — ALWAYS pass `warning`
 * for that case, per the "shown once" requirement).
 */
import { useEffect, useRef, useState } from "react";

const COPIED_FLASH_MS = 1500;

export function CopyableCode({
  value,
  warning,
  className = "",
}: {
  value: string;
  /** Non-null renders a warning line beneath the value (e.g. "shown once — copy it now"). */
  warning?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    });
  };

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-sm text-text-primary">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      {warning && <p className="mt-1 text-[11px] text-status-warning">{warning}</p>}
    </div>
  );
}
