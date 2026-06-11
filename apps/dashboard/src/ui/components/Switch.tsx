import { useId } from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";

// Toggle switch. Backed by Base UI's `Switch` (a `role="switch"` widget with
// keyboard support), styled as the Hermes pill + sliding thumb. Controlled via
// `checked`/`onCheckedChange`. Use for a single on/off setting (the settings
// page) where a slider toggle reads better than a checkbox.
//
// Labeling mirrors Checkbox: with `children` the control is `aria-labelledby` the
// visible text and the whole row is a <label> (the switch sits first, the text
// after it); without `children`, pass `aria-label`.

const ROW_CLASS = "hw-switch-row";
const ROOT_CLASS = "hw-switch";
const THUMB_CLASS = "hw-switch-thumb";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label text rendered after the switch (also the accessible name). */
  children?: React.ReactNode;
  disabled?: boolean;
  /** Accessible name when there is no visible `children` text. */
  "aria-label"?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  children,
  disabled,
  "aria-label": ariaLabel,
}: SwitchProps): React.ReactElement {
  const textId = useId();
  const hasText = children !== undefined;
  const root = (
    <BaseSwitch.Root
      className={ROOT_CLASS}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={hasText ? undefined : ariaLabel}
      aria-labelledby={hasText ? textId : undefined}
    >
      <BaseSwitch.Thumb className={THUMB_CLASS} />
    </BaseSwitch.Root>
  );
  if (!hasText) return root;
  return (
    <label className={ROW_CLASS}>
      {root}
      <span id={textId}>{children}</span>
    </label>
  );
}
