import { useCallback, useEffect, useState } from "react";
import { getApiClient } from "../host";
import { Button, Checkbox, Field, Input, Select } from "../ui/components";
import type { WorkflowsApi } from "../api/client";
import type { SettingsField, SettingsSchema, SettingsValue, WorkflowSettings } from "../api/types";

export interface SettingsPageProps {
  /** Injected for tests; defaults to the host-bound client. */
  client?: WorkflowsApi;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; schema: SettingsSchema };

function humanize(key: string): string {
  return key.replace(/_/g, " ");
}

export function SettingsPage({ client }: SettingsPageProps): React.ReactElement {
  const api = client ?? getApiClient();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [form, setForm] = useState<WorkflowSettings>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getSettings()
      .then(({ values, schema }) => {
        if (!active) return;
        setForm({ ...values });
        setState({ kind: "ready", schema });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [api]);

  const setField = useCallback((key: string, value: SettingsValue) => {
    setSaved(false);
    setError(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(() => {
    setSaved(false);
    setError(null);
    api
      .saveSettings(form)
      .then(({ values }) => {
        setForm({ ...values });
        setSaved(true);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to save settings."));
  }, [api, form]);

  if (state.kind === "loading") {
    return <p className="hw-page">Loading settings…</p>;
  }
  if (state.kind === "error") {
    return <p className="hw-page">Failed to load settings.</p>;
  }

  return (
    <div className="hw-page hw-page--narrow">
      <h2>Settings</h2>
      {state.schema.groups.map((group) => (
        <section key={group.key} className="hw-group">
          <h3>{group.label}</h3>
          <div className="hw-form">
            {group.fields.map((field) => (
              <SettingField key={field.key} field={field} value={form[field.key]} onChange={setField} />
            ))}
          </div>
        </section>
      ))}
      <div className="hw-row">
        <Button variant="primary" onClick={handleSave}>
          Save settings
        </Button>
        {saved && (
          <span role="status" className="hw-status">
            Settings saved.
          </span>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="hw-alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface FieldProps {
  field: SettingsField;
  value: SettingsValue | undefined;
  onChange: (key: string, value: SettingsValue) => void;
}

function SettingField({ field, value, onChange }: FieldProps): React.ReactElement {
  const id = `hw-set-${field.key}`;
  const label = `${humanize(field.key)}${field.enforced ? "" : " (not yet enforced)"}`;
  return (
    <Field label={label} htmlFor={id}>
      <Control id={id} label={label} field={field} value={value} onChange={onChange} />
    </Field>
  );
}

// A native Input associates with the Field's `<label htmlFor>` via `id`. The
// Base UI Select/Checkbox manage their own element ids, so they cannot be
// targeted by `htmlFor`; they carry the label as `aria-label` (one reliable
// accessible name). The visible Field label stays presentational for them.
function Control({
  id,
  label,
  field,
  value,
  onChange,
}: FieldProps & { id: string; label: string }): React.ReactElement {
  if (field.type === "bool") {
    return (
      <Checkbox
        aria-label={label}
        checked={Boolean(value)}
        onCheckedChange={(checked) => onChange(field.key, checked)}
      />
    );
  }
  if (field.type === "enum") {
    return (
      <Select
        aria-label={label}
        value={String(value ?? "")}
        items={(field.options ?? []).map((opt) => ({ value: opt, label: opt }))}
        onValueChange={(next) => onChange(field.key, next)}
      />
    );
  }
  if (field.type === "int") {
    return (
      <Input
        id={id}
        type="number"
        value={value === undefined || value === "" ? "" : String(value)}
        onChange={(e) => onChange(field.key, e.target.value === "" ? "" : Number(e.target.value))}
      />
    );
  }
  return (
    <Input
      id={id}
      type="text"
      value={String(value ?? "")}
      onChange={(e) => onChange(field.key, e.target.value)}
    />
  );
}
