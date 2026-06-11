import { useId } from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckIcon } from "../icons";

// Checkbox. Backed by Base UI's `Checkbox` (a `role="checkbox"` widget with
// keyboard support), styled as the Hermes box + check indicator. Controlled via
// `checked`/`onCheckedChange`.
//
// Labeling is explicit and single-sourced (a Base UI checkbox is not a native
// control, so a wrapping <label> does not name it on its own):
//  - with `children`, the box is `aria-labelledby` the visible text span and the
//    whole row is a <label> so clicking the text toggles it;
//  - without `children`, pass `aria-label` (e.g. when an external field renders
//    the visible label).

const ROW_CLASS = "hw-checkbox";
const ROOT_CLASS = "hw-checkbox-box";
const INDICATOR_CLASS = "hw-checkbox-indicator";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label text rendered after the box (also the accessible name). */
  children?: React.ReactNode;
  disabled?: boolean;
  /** Accessible name when there is no visible `children` text. */
  "aria-label"?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  children,
  disabled,
  "aria-label": ariaLabel,
}: CheckboxProps): React.ReactElement {
  const textId = useId();
  const hasText = children !== undefined;
  const box = (
    <BaseCheckbox.Root
      className={ROOT_CLASS}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={hasText ? undefined : ariaLabel}
      aria-labelledby={hasText ? textId : undefined}
    >
      <BaseCheckbox.Indicator className={INDICATOR_CLASS}>
        <CheckIcon />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
  if (!hasText) return box;
  return (
    <label className={ROW_CLASS}>
      {box}
      <span id={textId}>{children}</span>
    </label>
  );
}
