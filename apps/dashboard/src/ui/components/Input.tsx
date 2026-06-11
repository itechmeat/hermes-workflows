import { Input as BaseInput } from "@base-ui/react/input";

// Single-line text/number input. Backed by Base UI's `Input` (renders a native
// <input>, Field-aware), carrying the shared `hw-input` look. Controlled via the
// native `value`/`onChange` the call sites already use; `type="number"` is
// supported directly (we deliberately do NOT use Base UI's NumberField widget —
// see DESIGN.md). Extra classes append to the base class, never replace it.

const INPUT_CLASS = "hw-input";

export interface InputProps extends Omit<React.ComponentProps<typeof BaseInput>, "className"> {
  /** Extra classes appended after `hw-input`. */
  className?: string;
}

export function Input({ className, ...rest }: InputProps): React.ReactElement {
  const classes = [INPUT_CLASS, className].filter(Boolean).join(" ");
  return <BaseInput className={classes} {...rest} />;
}
