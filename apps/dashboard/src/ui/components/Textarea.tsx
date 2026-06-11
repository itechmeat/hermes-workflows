// Multi-line text input. Base UI ships no textarea primitive, so this wraps a
// native <textarea> — it exists for call-site consistency (every control goes
// through the component layer) and to carry the shared `hw-input` look. Pass
// `hw-textarea--tall` via `className` for the large prompt/command editors.

const TEXTAREA_CLASS = "hw-input";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function Textarea({ className, ...rest }: TextareaProps): React.ReactElement {
  const classes = [TEXTAREA_CLASS, className].filter(Boolean).join(" ");
  return <textarea className={classes} {...rest} />;
}
