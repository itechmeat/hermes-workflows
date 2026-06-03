// Page header row: an <h2> title pushed left, optional actions on the right.
// The `.hw-pagehead` rule margins the first child to the right, so actions
// naturally trail. Shared by the list pages (Workflows, Runs, Schedules).

export interface PageHeaderProps {
  title: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ title, actions }: PageHeaderProps): React.ReactElement {
  return (
    <div className="hw-pagehead">
      <h2>{title}</h2>
      {actions}
    </div>
  );
}
