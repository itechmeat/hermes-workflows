import { useEffect, useRef, useState } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { ChevronDownIcon } from "../icons";

// Dropdown menu: a trigger Button (with a caret that flips when open) that
// toggles a popover list of items. Closes on item select, on outside click,
// and on Escape. One primitive for every toolbar/header menu (add-node, tools).

export interface MenuItem {
  key: string;
  label: React.ReactNode;
  /** Optional leading icon rendered before the label. */
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export interface MenuProps {
  label: React.ReactNode;
  items: MenuItem[];
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Popover horizontal anchor: "start" (default) opens to the right of the
   *  trigger; "end" anchors to the trigger's right edge and opens to the left
   *  (use for triggers near the right edge, e.g. table-row action menus). */
  align?: "start" | "end";
  /** Disables the trigger button (e.g. while editor playback locks editing). */
  disabled?: boolean;
}

export function Menu({
  label,
  items,
  variant = "default",
  size = "md",
  align = "start",
  disabled,
}: MenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="hw-menu-wrap" ref={wrapRef}>
      <Button
        variant={variant}
        size={size}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <span className="hw-menu-caret">
          <ChevronDownIcon />
        </span>
      </Button>
      {open && (
        <div className={align === "end" ? "hw-menu hw-menu--end" : "hw-menu"} role="menu">
          {items.map((item) => (
            <Button
              key={item.key}
              role="menuitem"
              size={size}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon !== undefined && <span className="hw-menu-icon">{item.icon}</span>}
              {item.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
