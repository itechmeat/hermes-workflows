// Status pill. `tone` selects a semantic variant (`hw-badge--<tone>`); omit it
// for the neutral pill. Reused by every table that shows a status/state.

export interface BadgeProps {
  tone?: string;
  children: React.ReactNode;
}

export function Badge({ tone, children }: BadgeProps): React.ReactElement {
  return <span className={tone ? `hw-badge hw-badge--${tone}` : "hw-badge"}>{children}</span>;
}
