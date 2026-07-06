import { useEffect, useRef, useState, type ReactNode } from "react";

/** How long an armed button waits for the confirming click before disarming. */
const ARM_MS = 4000;

interface ConfirmButtonProps {
  /** Resting label. */
  children: ReactNode;
  /** Armed ("are you sure") label. */
  confirmLabel?: ReactNode;
  onConfirm: () => void;
  className?: string;
  /** Extra classes applied only while armed. */
  armedClassName?: string;
  disabled?: boolean;
  title?: string;
}

/**
 * Two-step destructive button — the lab's confirmation idiom: first click
 * arms it (label flips to confirmLabel), a second click within ARM_MS fires
 * onConfirm, otherwise it disarms itself. Inline and lightweight on purpose:
 * no window.confirm dialog, no focus stealing, styling supplied by the
 * caller so it drops into any existing button row unchanged.
 */
export function ConfirmButton({
  children,
  confirmLabel = "sure? click again",
  onConfirm,
  className = "",
  armedClassName = "",
  disabled,
  title,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const disarm = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(false);
  };

  return (
    <button
      type="button"
      className={armed && armedClassName ? `${className} ${armedClassName}` : className}
      disabled={disabled}
      title={title}
      onClick={() => {
        if (armed) {
          disarm();
          onConfirm();
          return;
        }
        setArmed(true);
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          setArmed(false);
        }, ARM_MS);
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
