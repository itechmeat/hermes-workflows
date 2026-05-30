// Typed client for the workflows dashboard routes (mounted at
// /api/plugins/workflows/). Pure wiring over an injected `fetchJSON`: it builds
// URLs and JSON bodies and unwraps list envelopes, so it is fully unit-testable
// without a network. The host's `fetchJSON` spreads `init` into `fetch` and does
// not serialize bodies, so writes set Content-Type and stringify here.
import type {
  HermesPlan,
  O2BStatus,
  RunOptions,
  RunStartResult,
  RunState,
  RunSummary,
  SaveWorkflowBody,
  SpecDetail,
  ValidationResult,
  WorkflowListItem,
} from "./types";

export type FetchJSON = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export interface WorkflowsApi {
  listWorkflows(): Promise<WorkflowListItem[]>;
  getWorkflow(id: string): Promise<SpecDetail>;
  saveWorkflow(id: string, body: SaveWorkflowBody): Promise<SpecDetail>;
  validateWorkflow(id: string): Promise<ValidationResult>;
  compilePreview(id: string): Promise<HermesPlan>;
  runWorkflow(id: string, options?: RunOptions): Promise<RunStartResult>;
  listRuns(): Promise<RunSummary[]>;
  getRun(id: string): Promise<RunState>;
  cancelRun(id: string): Promise<RunState>;
  retryRun(id: string, node?: string): Promise<RunState>;
  o2bStatus(): Promise<O2BStatus>;
}

const BASE = "/api/plugins/workflows";

export function createApiClient(fetchJSON: FetchJSON): WorkflowsApi {
  const workflow = (id: string): string => `${BASE}/workflows/${encodeURIComponent(id)}`;
  const run = (id: string): string => `${BASE}/runs/${encodeURIComponent(id)}`;

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

    async listRuns() {
      const { runs } = await fetchJSON<{ runs?: RunSummary[] }>(`${BASE}/runs`);
      return runs ?? [];
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

    o2bStatus() {
      return fetchJSON<O2BStatus>(`${BASE}/o2b-status`);
    },
  };
}
