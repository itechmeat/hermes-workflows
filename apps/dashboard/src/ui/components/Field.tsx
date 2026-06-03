// Labelled form field. Two association modes:
//  - `htmlFor` set  → renders a <div> with a `for`-linked <label> (use when the
//    control owns the id, e.g. the Settings controls).
//  - `htmlFor` unset → the field IS a <label> wrapping its control (implicit
//    association, e.g. the node inspector inputs).

export interface FieldProps {
  label: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, children }: FieldProps): React.ReactElement {
  if (htmlFor !== undefined) {
    return (
      <div className="hw-field">
        <label className="hw-label" htmlFor={htmlFor}>
          {label}
        </label>
        {children}
      </div>
    );
  }
  return (
    <label className="hw-field">
      <span className="hw-label">{label}</span>
      {children}
    </label>
  );
}
