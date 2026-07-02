// Typed client for the workflows dashboard routes (mounted at
// /api/plugins/hermes-workflows/). Pure wiring over an injected `fetchJSON`: it builds
// URLs and JSON bodies and unwraps list envelopes, so it is fully unit-testable
// without a network. The host's `fetchJSON` spreads `init` into `fetch` and does
// not serialize bodies, so writes set Content-Type and stringify here.
import type {
  CreateWorkflowBody,
  DeleteResult,
  ExportedRun,
  ExportedTemplate,
  ExportedWorkflow,
  HermesPlan,
  ModelGroup,
  O2BStatus,
  RunOptions,
  RunStartResult,
  RunState,
  RunSummary,
  ScheduleListItem,
  SettingsResponse,
  WorkflowSettings,
  SaveWorkflowBody,
  SpecDetail,
  ValidationResult,
  WorkflowListItem,
} from "./types";

export type FetchJSON = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

/** Which runs the Runs page asks for: in-flight only (default) or every run. */
export type RunScope = "active" | "all";

export interface WorkflowsApi {
  listWorkflows(): Promise<WorkflowListItem[]>;
  getWorkflow(id: string): Promise<SpecDetail>;
  createWorkflow(body: CreateWorkflowBody): Promise<SpecDetail>;
  deleteWorkflow(id: string): Promise<DeleteResult>;
  setWorkflowEnabled(id: string, enabled: boolean): Promise<SpecDetail>;
  exportWorkflow(id: string): Promise<ExportedWorkflow>;
  /** Export the workflow as an installation-agnostic template + adaptation guide. */
  exportTemplate(id: string): Promise<ExportedTemplate>;
  saveWorkflow(id: string, body: SaveWorkflowBody): Promise<SpecDetail>;
  validateWorkflow(id: string): Promise<ValidationResult>;
  compilePreview(id: string): Promise<HermesPlan>;
  runWorkflow(id: string, options?: RunOptions): Promise<RunStartResult>;
  /** `workflowId` narrows to one workflow's runs, newest first — the editor's
   *  attach lookup. */
  listRuns(scope?: RunScope, workflowId?: string): Promise<RunSummary[]>;
  exportRunLogs(id: string): Promise<ExportedRun>;
  getRun(id: string): Promise<RunState>;
  cancelRun(id: string): Promise<RunState>;
  retryRun(id: string, node?: string): Promise<RunState>;
  listSchedules(): Promise<ScheduleListItem[]>;
  pauseSchedule(id: string): Promise<unknown>;
  resumeSchedule(id: string): Promise<unknown>;
  runScheduleNow(id: string): Promise<unknown>;
  editSchedule(id: string, cron: string): Promise<unknown>;
  deleteSchedule(id: string): Promise<DeleteResult>;
  getSettings(): Promise<SettingsResponse>;
  saveSettings(values: WorkflowSettings): Promise<SettingsResponse>;
  o2bStatus(): Promise<O2BStatus>;
  /** Agent-task profile names from the user's Hermes roster. */
  listProfiles(): Promise<string[]>;
  /** Models grouped by authenticated provider (from the host model picker). */
  listModels(): Promise<ModelGroup[]>;
  /** Skill names installed in the host (enabled ones), for import normalization. */
  listSkills(): Promise<string[]>;
}

const BASE = "/api/plugins/hermes-workflows";

export function createApiClient(fetchJSON: FetchJSON): WorkflowsApi {
  const workflow = (id: string): string => `${BASE}/workflows/${encodeURIComponent(id)}`;
  const run = (id: string): string => `${BASE}/runs/${encodeURIComponent(id)}`;
  const schedule = (id: string): string => `${BASE}/schedules/${encodeURIComponent(id)}`;

  const postJson = <T>(path: string, body: unknown): Promise<T> =>
    fetchJSON<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    async listWorkflows() {
      const { workflows } = await fetchJSON<{ workflows?: WorkflowListItem[] }>(
        `${BASE}/workflows`,
      );
      return workflows ?? [];
    },

    getWorkflow(id) {
      return fetchJSON<SpecDetail>(workflow(id));
    },

    createWorkflow(body) {
      return postJson<SpecDetail>(`${BASE}/workflows`, body);
    },

    deleteWorkflow(id) {
      return fetchJSON<DeleteResult>(workflow(id), { method: "DELETE" });
    },

    setWorkflowEnabled(id, enabled) {
      return fetchJSON<SpecDetail>(`${workflow(id)}/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    },

    exportWorkflow(id) {
      return fetchJSON<ExportedWorkflow>(`${workflow(id)}/export`);
    },
    exportTemplate(id) {
      return fetchJSON<ExportedTemplate>(`${workflow(id)}/export-template`);
    },

    saveWorkflow(id, body) {
      return fetchJSON<SpecDetail>(workflow(id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },

    validateWorkflow(id) {
      return postJson<ValidationResult>(`${workflow(id)}/validate`, {});
    },

    compilePreview(id) {
      return postJson<HermesPlan>(`${workflow(id)}/compile-preview`, {});
    },

    runWorkflow(id, options) {
      return postJson<RunStartResult>(`${workflow(id)}/run`, options ?? {});
    },

    async listRuns(scope, workflowId) {
      const params = new URLSearchParams();
      if (scope === "all") params.set("scope", "all");
      if (workflowId !== undefined) params.set("workflow_id", workflowId);
      const query = params.size > 0 ? `?${params}` : "";
      const { runs } = await fetchJSON<{ runs?: RunSummary[] }>(`${BASE}/runs${query}`);
      return runs ?? [];
    },

    exportRunLogs(id) {
      return fetchJSON<ExportedRun>(`${run(id)}/export`);
    },

    getRun(id) {
      return fetchJSON<RunState>(run(id));
    },

    cancelRun(id) {
      return postJson<RunState>(`${run(id)}/cancel`, {});
    },

    retryRun(id, node) {
      return postJson<RunState>(`${run(id)}/retry`, node === undefined ? {} : { node_id: node });
    },

    async listSchedules() {
      const { schedules } = await fetchJSON<{ schedules?: ScheduleListItem[] }>(
        `${BASE}/schedules`,
      );
      return schedules ?? [];
    },

    pauseSchedule(id) {
      return postJson<unknown>(`${schedule(id)}/pause`, {});
    },

    resumeSchedule(id) {
      return postJson<unknown>(`${schedule(id)}/resume`, {});
    },

    runScheduleNow(id) {
      return postJson<unknown>(`${schedule(id)}/run`, {});
    },

    editSchedule(id, cron) {
      return fetchJSON<unknown>(schedule(id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron }),
      });
    },

    deleteSchedule(id) {
      return fetchJSON<DeleteResult>(schedule(id), { method: "DELETE" });
    },

    getSettings() {
      return fetchJSON<SettingsResponse>(`${BASE}/settings`);
    },

    saveSettings(values) {
      return fetchJSON<SettingsResponse>(`${BASE}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
    },

    o2bStatus() {
      return fetchJSON<O2BStatus>(`${BASE}/o2b-status`);
    },
    async listProfiles() {
      const r = await fetchJSON<{ profiles: string[] }>(`${BASE}/profiles`);
      return r.profiles ?? [];
    },
    async listModels() {
      // The host gateway owns the authoritative model picker — every
      // authenticated provider and its models. We read it directly (not a
      // plugin route) so the list matches the rest of the dashboard.
      const r = await fetchJSON<{
        providers?: { slug?: string; name?: string; models?: string[] }[];
      }>("/api/model/options");
      return (r.providers ?? [])
        .filter((p) => Array.isArray(p.models) && p.models.length > 0)
        .map((p) => ({
          provider: p.slug ?? "",
          label: p.name ?? p.slug ?? "",
          models: p.models ?? [],
        }));
    },
    async listSkills() {
      // The host owns the authoritative skills catalogue (`/api/skills` returns
      // every enabled skill with its `name`). Read it directly — same source
      // the rest of the dashboard uses — rather than duplicating a plugin route.
      const r = await fetchJSON<{ name?: string }[]>("/api/skills");
      // A malformed payload must fail, not coerce to an empty list — import
      // normalization treats a fulfilled result as a VERIFIED catalogue, so an
      // empty-on-garbage value would silently strip every imported skill.
      if (!Array.isArray(r)) {
        throw new Error("Unexpected /api/skills response: expected an array");
      }
      return r
        .map((s) => s.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
    },
  };
}
