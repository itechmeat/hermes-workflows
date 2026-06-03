// Design-system button. One primitive for every clickable action in the
// plugin, so variant/size live here instead of being re-spelled as `hw-btn …`
// class strings at each call site. Defaults to type="button" to avoid
// accidental form submits; pass type="submit" explicitly when needed.

export type ButtonVariant = "default" | "primary" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary: "hw-btn--primary",
  danger: "hw-btn--danger",
};

export function Button({
  variant = "default",
  size = "md",
  type = "button",
  className,
  ...rest
}: ButtonProps): React.ReactElement {
  const classes = ["hw-btn", VARIANT_CLASS[variant], size === "sm" ? "hw-btn--sm" : "", className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...rest} />;
}
