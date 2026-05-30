import { useCallback, useEffect, useState } from "react";
import { getApiClient } from "../host";
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
    return <p style={{ padding: 16 }}>Loading settings…</p>;
  }
  if (state.kind === "error") {
    return <p style={{ padding: 16 }}>Failed to load settings.</p>;
  }

  return (
    <div style={{ padding: 16, maxWidth: 640 }}>
      <h2>Settings</h2>
      {state.schema.groups.map((group) => (
        <section key={group.key} style={{ marginBottom: 20 }}>
          <h3 style={{ margin: "12px 0 8px" }}>{group.label}</h3>
          {group.fields.map((field) => (
            <Field key={field.key} field={field} value={form[field.key]} onChange={setField} />
          ))}
        </section>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="hw-btn hw-btn--primary" onClick={handleSave}>
          Save settings
        </button>
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

function Field({ field, value, onChange }: FieldProps): React.ReactElement {
  const id = `hw-set-${field.key}`;
  const label = `${humanize(field.key)}${field.enforced ? "" : " (not yet enforced)"}`;
  return (
    <div className="hw-field" style={{ marginBottom: 10 }}>
      <label className="hw-label" htmlFor={id}>
        {label}
      </label>
      <Control id={id} field={field} value={value} onChange={onChange} />
    </div>
  );
}

function Control({ id, field, value, onChange }: FieldProps & { id: string }): React.ReactElement {
  if (field.type === "bool") {
    return (
      <input
        id={id}
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(field.key, e.target.checked)}
      />
    );
  }
  if (field.type === "enum") {
    return (
      <select
        id={id}
        className="hw-select"
        value={String(value ?? "")}
        onChange={(e) => onChange(field.key, e.target.value)}
      >
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "int") {
    return (
      <input
        id={id}
        type="number"
        className="hw-input"
        value={value === undefined || value === "" ? "" : String(value)}
        onChange={(e) => onChange(field.key, e.target.value === "" ? "" : Number(e.target.value))}
      />
    );
  }
  return (
    <input
      id={id}
      type="text"
      className="hw-input"
      value={String(value ?? "")}
      onChange={(e) => onChange(field.key, e.target.value)}
    />
  );
}
