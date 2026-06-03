import { useEffect, useId } from "react";
import { Button } from "./Button";

// Reusable modal dialog: a dimmed overlay, a centred dialog box, a titled
// header with a close affordance, a scrollable body, and an optional actions
// footer. Dismisses on Escape, on overlay click, and on the close button — so
// every modal in the plugin gets the same behaviour and a11y wiring for free.

export interface ModalProps {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  /** Buttons rendered in the footer. Omit to render no footer (e.g. when the
   *  body is a <form> that owns its own submit/cancel actions). */
  footer?: React.ReactNode;
  /** Extra class on the dialog box, e.g. a width modifier. */
  className?: string;
  /** Accessible name; defaults to `title` when it is a plain string. */
  ariaLabel?: string;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  className,
  ariaLabel,
}: ModalProps): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const label = ariaLabel ?? (typeof title === "string" ? title : undefined);
  // When the title is a non-string node and no ariaLabel is given, name the
  // dialog via the visible heading instead, so it is never unannounced.
  const titleId = useId();

  return (
    <div className="hw-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className={className ? `hw-modal ${className}` : "hw-modal"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={label === undefined ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hw-modal-header">
          <h3 id={label === undefined ? titleId : undefined}>{title}</h3>
          <Button size="sm" aria-label="Close" onClick={onClose}>
            ✕
          </Button>
        </div>
        <div className="hw-modal-body">{children}</div>
        {footer !== undefined && <div className="hw-modal-actions">{footer}</div>}
      </div>
    </div>
  );
}
