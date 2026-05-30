// Typed client for the workflows dashboard routes (mounted at
// /api/plugins/workflows/). Pure wiring over an injected `fetchJSON`: it builds
// URLs and JSON bodies and unwraps list envelopes, so it is fully unit-testable
// without a network. The host's `fetchJSON` spreads `init` into `fetch` and does
// not serialize bodies, so writes set Content-Type and stringify here.
import type {
  CreateWorkflowBody,
  DeleteResult,
  ExportedRun,
  ExportedWorkflow,
  HermesPlan,
  O2BStatus,
  RunOptions,
  RunStartResult,
  RunState,
  RunSummary,
  ScheduleListItem,
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
  exportWorkflow(id: string): Promise<ExportedWorkflow>;
  saveWorkflow(id: string, body: SaveWorkflowBody): Promise<SpecDetail>;
  validateWorkflow(id: string): Promise<ValidationResult>;
  compilePreview(id: string): Promise<HermesPlan>;
  runWorkflow(id: string, options?: RunOptions): Promise<RunStartResult>;
  listRuns(scope?: RunScope): Promise<RunSummary[]>;
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
  o2bStatus(): Promise<O2BStatus>;
}

const BASE = "/api/plugins/workflows";

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
      const { workflows } = await fetchJSON<{ workflows?: WorkflowListItem[] }>(`${BASE}/workflows`);
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

    exportWorkflow(id) {
      return fetchJSON<ExportedWorkflow>(`${workflow(id)}/export`);
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

    async listRuns(scope) {
      const query = scope === "all" ? "?scope=all" : "";
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
      const { schedules } = await fetchJSON<{ schedules?: ScheduleListItem[] }>(`${BASE}/schedules`);
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

    o2bStatus() {
      return fetchJSON<O2BStatus>(`${BASE}/o2b-status`);
    },
  };
}
