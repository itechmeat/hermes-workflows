/**
 * Typed parameters for workflow templates, and the per-surface emitters that
 * render them — the parallel of the host's `cron/blueprint_catalog.py`.
 *
 * A template's `params` is the single source of truth. From it we emit what each
 * surface needs natively, all as PURE functions (no I/O):
 *   - `paramFormSchema`  → a dashboard form (one field per param)
 *   - `paramSlashCommand`→ a ready-to-paste `/workflow <key> name=val …` line
 *   - `paramDeeplink`    → a `hermes://workflow/<key>?name=val` deep-link URL
 *   - `agentSeed`        → a natural-language fill request for the agent
 *   - `catalogEntry`     → the unified shape (form + command + deep-link)
 * `fillParams` validates supplied values (the instantiation half of the
 * contract). Mirrors the host module so behaviour stays native: unknown params
 * are rejected, required params enforced, strict enums checked, and a
 * non-strict enum accepts any value (validated downstream).
 *
 * The live `/workflow` chat command and `hermes://` resolution are host
 * surfaces we cannot register; these emitters produce the strings those
 * surfaces (and the docs catalog) consume.
 */

export type ParamType = "text" | "enum" | "int" | "bool";

export type ParamValue = string | number | boolean;

/** A single fillable parameter on a workflow template (mirrors BlueprintSlot). */
export interface WorkflowParam {
  name: string;
  type: ParamType;
  label: string;
  default?: ParamValue;
  /** Allowed values for `type: "enum"`. */
  options?: string[];
  optional?: boolean;
  /** When false, `options` are suggestions and any value is accepted (the
   *  gateway validates downstream, e.g. a deliver target). Defaults to true. */
  strict?: boolean;
  help?: string;
}

/** A parameterized workflow template: its identity plus its typed params. */
export interface WorkflowTemplate {
  key: string;
  title: string;
  description: string;
  params: WorkflowParam[];
}

/** A form field a renderer needs for one param. */
export interface ParamFormField {
  name: string;
  type: ParamType;
  label: string;
  default?: ParamValue;
  options: string[];
  optional: boolean;
  strict: boolean;
  help: string;
}

/** The unified, serializable shape for a template across surfaces. */
export interface CatalogEntry {
  key: string;
  title: string;
  description: string;
  fields: ParamFormField[];
  command: string;
  appUrl: string;
}

/** Raised when supplied param values fail validation. */
export class ParamFillError extends Error {
  override name = "ParamFillError";
}

/** Whether a raw value is "absent" (no value supplied and no default). */
function isBlank(value: ParamValue | undefined): boolean {
  return value === undefined || value === null || value === "";
}

/** Whether an enum param is strict (the default). */
function isStrict(param: WorkflowParam): boolean {
  return param.strict !== false;
}

export function paramFormSchema(params: WorkflowParam[]): ParamFormField[] {
  return params.map((p) => ({
    name: p.name,
    type: p.type,
    label: p.label,
    ...(p.default !== undefined ? { default: p.default } : {}),
    options: p.options ?? [],
    optional: p.optional === true,
    strict: isStrict(p),
    help: p.help ?? "",
  }));
}

/** A scalar that needs quoting in the slash command: free text or any value
 *  carrying a space. Quoted as a JSON string so embedded quotes survive. */
function slashValue(param: WorkflowParam, value: ParamValue): string {
  const text = String(value);
  return param.type === "text" || text.includes(" ") ? JSON.stringify(text) : text;
}

export function paramSlashCommand(
  key: string,
  params: WorkflowParam[],
  values: Record<string, ParamValue> = {},
): string {
  const parts = [`/workflow ${key}`];
  for (const param of params) {
    const value = values[param.name] ?? param.default;
    if (isBlank(value)) {
      if (param.optional) continue;
      parts.push(`${param.name}=`);
      continue;
    }
    parts.push(`${param.name}=${slashValue(param, value as ParamValue)}`);
  }
  return parts.join(" ");
}

export function paramDeeplink(
  key: string,
  params: WorkflowParam[],
  values: Record<string, ParamValue> = {},
): string {
  const query: string[] = [];
  for (const param of params) {
    const value = values[param.name] ?? param.default;
    if (isBlank(value)) continue;
    query.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(String(value))}`);
  }
  const qs = query.length > 0 ? `?${query.join("&")}` : "";
  return `hermes://workflow/${encodeURIComponent(key)}${qs}`;
}

export function catalogEntry(template: WorkflowTemplate): CatalogEntry {
  return {
    key: template.key,
    title: template.title,
    description: template.description,
    fields: paramFormSchema(template.params),
    command: paramSlashCommand(template.key, template.params),
    appUrl: paramDeeplink(template.key, template.params),
  };
}

export function agentSeed(template: WorkflowTemplate): string {
  const lines: string[] = [
    `Set up the '${template.title}' workflow (template '${template.key}'). ${template.description}`,
    "",
    "Ask me for each of these, one at a time, offering the default in brackets if I don't have a preference:",
  ];
  for (const p of template.params) {
    let line = `- ${p.label} (${p.name})`;
    if (p.options && p.options.length > 0) line += ` — one of: ${p.options.join(", ")}`;
    if (!isBlank(p.default)) line += ` [default: ${String(p.default)}]`;
    if (p.optional) line += " (optional)";
    if (p.help) line += ` — ${p.help}`;
    lines.push(line);
  }
  lines.push(
    "",
    "Once you have my answers, instantiate the workflow with those values substituted into its node prompts, then run it.",
  );
  return lines.join("\n");
}

/** Coerce + validate one supplied (or default) value against its param type. */
function coerceValue(param: WorkflowParam, raw: ParamValue): ParamValue {
  if (param.type === "enum") {
    const text = String(raw);
    if (
      isStrict(param) &&
      param.options &&
      param.options.length > 0 &&
      !param.options.includes(text)
    ) {
      throw new ParamFillError(
        `${param.name}=${text} not allowed — one of ${param.options.join(", ")}`,
      );
    }
    return text;
  }
  if (param.type === "int") {
    // A boolean Number()-coerces to 0/1, which would pass Number.isInteger; an
    // int param must come from a number or a numeric string, never a bool.
    const n = typeof raw === "boolean" ? Number.NaN : Number(raw);
    if (!Number.isInteger(n)) {
      throw new ParamFillError(`${param.name} must be an integer, got '${String(raw)}'`);
    }
    return n;
  }
  if (param.type === "bool") {
    if (typeof raw === "boolean") return raw;
    const text = String(raw).toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
    throw new ParamFillError(`${param.name} must be a boolean, got '${String(raw)}'`);
  }
  return String(raw);
}

/**
 * Validate `values` against `params` and return the resolved value map. Unknown
 * names are rejected (a typo must not silently use a default); missing required
 * params raise naming the param; enum/int/bool values are checked.
 */
export function fillParams(
  params: WorkflowParam[],
  values: Record<string, ParamValue>,
): Record<string, ParamValue> {
  const known = new Set(params.map((p) => p.name));
  const unknown = Object.keys(values).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new ParamFillError(
      `unknown param${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} — ` +
        `valid: ${params.map((p) => p.name).join(", ")}`,
    );
  }
  const resolved: Record<string, ParamValue> = {};
  for (const param of params) {
    const raw = values[param.name] ?? param.default;
    if (isBlank(raw)) {
      if (param.optional) continue;
      throw new ParamFillError(`missing required value: ${param.name} (${param.label})`);
    }
    resolved[param.name] = coerceValue(param, raw as ParamValue);
  }
  return resolved;
}
