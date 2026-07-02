import { describe, it, expect, vi } from "vitest";
import { createApiClient, type FetchJSON } from "../src/api/client";

interface Call {
  path: string;
  init: RequestInit | undefined;
}

function harness() {
  const calls: Call[] = [];
  let response: unknown = {};
  const fetchJSON = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return response;
  });
  return {
    calls,
    client: createApiClient(fetchJSON as unknown as FetchJSON),
    reply(value: unknown) {
      response = value;
    },
    last(): Call {
      const call = calls.at(-1);
      if (!call) throw new Error("no call recorded");
      return call;
    },
  };
}

const BASE = "/api/plugins/hermes-workflows";

describe("workflows API client", () => {
  it("lists workflows and unwraps the envelope", async () => {
    const h = harness();
    const item = { id: "wf-1", name: "First", scope: "global", trigger: { type: "manual" } };
    h.reply({ workflows: [item] });

    const result = await h.client.listWorkflows();

    expect(result).toEqual([item]);
    expect(h.last().path).toBe(`${BASE}/workflows`);
    expect(h.last().init?.method ?? "GET").toBe("GET");
  });

  it("returns an empty list when the envelope omits workflows", async () => {
    const h = harness();
    h.reply({});
    expect(await h.client.listWorkflows()).toEqual([]);
  });

  it("gets one workflow by id", async () => {
    const h = harness();
    const detail = { workflow: { id: "wf-1" }, path: "/x/wf-1.workflow.yaml" };
    h.reply(detail);

    const result = await h.client.getWorkflow("wf-1");

    expect(result).toBe(detail);
    expect(h.last().path).toBe(`${BASE}/workflows/wf-1`);
  });

  it("encodes the id into the URL path", async () => {
    const h = harness();
    h.reply({ workflow: { id: "a/b" }, path: "" });
    await h.client.getWorkflow("a/b");
    expect(h.last().path).toBe(`${BASE}/workflows/a%2Fb`);
  });

  it("saves a workflow with a JSON PUT body", async () => {
    const h = harness();
    const body = { workflow: { id: "wf-1" }, ui: { xyflow: { nodes: [] } } } as never;
    const saved = { workflow: { id: "wf-1" }, path: "/x/wf-1.workflow.yaml" };
    h.reply(saved);

    const result = await h.client.saveWorkflow("wf-1", body);

    expect(result).toBe(saved);
    const call = h.last();
    expect(call.path).toBe(`${BASE}/workflows/wf-1`);
    expect(call.init?.method).toBe("PUT");
    expect(new Headers(call.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual(body);
  });

  it("carries the Templates run/next-run columns on a list row", async () => {
    const h = harness();
    const item = {
      id: "wf-1",
      name: "First",
      scope: "global",
      trigger: { type: "manual" },
      enabled: false,
      last_run_at: 1700,
      last_status: "completed",
      next_run_at: null,
    };
    h.reply({ workflows: [item] });
    const [row] = await h.client.listWorkflows();
    expect(row).toEqual(item);
    expect(row?.enabled).toBe(false);
  });

  it("toggles a workflow's enabled flag via PUT", async () => {
    const h = harness();
    const saved = { workflow: { id: "wf-1", enabled: false }, path: "/x/wf-1.workflow.yaml" };
    h.reply(saved);

    const result = await h.client.setWorkflowEnabled("wf-1", false);

    expect(result).toBe(saved);
    const call = h.last();
    expect(call.path).toBe(`${BASE}/workflows/wf-1/enabled`);
    expect(call.init?.method).toBe("PUT");
    expect(new Headers(call.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual({ enabled: false });
  });

  it("validates a workflow via POST", async () => {
    const h = harness();
    const verdict = { valid: true, errors: [], warnings: [] };
    h.reply(verdict);

    const result = await h.client.validateWorkflow("wf-1");

    expect(result).toBe(verdict);
    expect(h.last().path).toBe(`${BASE}/workflows/wf-1/validate`);
    expect(h.last().init?.method).toBe("POST");
  });

  it("requests a compile preview via POST", async () => {
    const h = harness();
    h.reply({ workflow_id: "wf-1", kanban_tasks: [] });
    await h.client.compilePreview("wf-1");
    expect(h.last().path).toBe(`${BASE}/workflows/wf-1/compile-preview`);
    expect(h.last().init?.method).toBe("POST");
  });

  it("starts a run, forwarding an optional project id", async () => {
    const h = harness();
    h.reply({ run_id: "wf-1-abc", status: "running" });

    const result = await h.client.runWorkflow("wf-1", { project_id: "proj" });

    expect(result).toEqual({ run_id: "wf-1-abc", status: "running" });
    const call = h.last();
    expect(call.path).toBe(`${BASE}/workflows/wf-1/run`);
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(String(call.init?.body))).toEqual({ project_id: "proj" });
  });

  it("starts a run with an empty body when no options are given", async () => {
    const h = harness();
    h.reply({ run_id: "wf-1-abc", status: "running" });
    await h.client.runWorkflow("wf-1");
    expect(JSON.parse(String(h.last().init?.body))).toEqual({});
  });

  it("forwards an operator input directive to the run endpoint", async () => {
    const h = harness();
    h.reply({ run_id: "wf-1-abc", status: "running" });
    await h.client.runWorkflow("wf-1", { input: "ship the urgent fix first" });
    expect(JSON.parse(String(h.last().init?.body))).toEqual({
      input: "ship the urgent fix first",
    });
  });

  it("lists runs and unwraps the envelope (active by default)", async () => {
    const h = harness();
    const run = { run_id: "r1", workflow_id: "wf-1", status: "running" };
    h.reply({ runs: [run] });

    const result = await h.client.listRuns();

    expect(result).toEqual([run]);
    expect(h.last().path).toBe(`${BASE}/runs`);
  });

  it("lists all runs with the scope query when asked", async () => {
    const h = harness();
    h.reply({ runs: [] });
    await h.client.listRuns("all");
    expect(h.last().path).toBe(`${BASE}/runs?scope=all`);
  });

  it("filters runs by workflow id (the editor attach lookup)", async () => {
    const h = harness();
    h.reply({ runs: [] });
    await h.client.listRuns("active", "deploy me");
    // workflow_id rides as an encoded query param alongside the scope default.
    expect(h.last().path).toBe(`${BASE}/runs?workflow_id=deploy+me`);

    h.reply({ runs: [] });
    await h.client.listRuns("all", "wf-1");
    expect(h.last().path).toBe(`${BASE}/runs?scope=all&workflow_id=wf-1`);
  });

  it("exports a run's log bundle, returning the JSON envelope", async () => {
    const h = harness();
    const envelope = { run_id: "r1", filename: "r1.run.json", json: { run_id: "r1", nodes: {} } };
    h.reply(envelope);

    const result = await h.client.exportRunLogs("r1");

    expect(result).toBe(envelope);
    expect(h.last().path).toBe(`${BASE}/runs/r1/export`);
    expect(h.last().init?.method ?? "GET").toBe("GET");
  });

  it("gets a run by id", async () => {
    const h = harness();
    const run = { run_id: "r1", workflow_id: "wf-1", status: "running", nodes: {} };
    h.reply(run);

    const result = await h.client.getRun("r1");

    expect(result).toBe(run);
    expect(h.last().path).toBe(`${BASE}/runs/r1`);
  });

  it("cancels a run via POST", async () => {
    const h = harness();
    h.reply({ run_id: "r1", status: "cancelled", nodes: {} });
    await h.client.cancelRun("r1");
    expect(h.last().path).toBe(`${BASE}/runs/r1/cancel`);
    expect(h.last().init?.method).toBe("POST");
  });

  it("retries a whole run with an empty body", async () => {
    const h = harness();
    h.reply({ run_id: "r1", status: "running", nodes: {} });
    await h.client.retryRun("r1");
    expect(h.last().path).toBe(`${BASE}/runs/r1/retry`);
    expect(h.last().init?.method).toBe("POST");
    expect(JSON.parse(String(h.last().init?.body))).toEqual({});
  });

  it("retries a single node, forwarding node_id", async () => {
    const h = harness();
    h.reply({ run_id: "r1", status: "running", nodes: {} });
    await h.client.retryRun("r1", "node-a");
    expect(JSON.parse(String(h.last().init?.body))).toEqual({ node_id: "node-a" });
  });

  it("lists schedules and unwraps the envelope", async () => {
    const h = harness();
    const sched = { workflow_id: "blog", cron_expression: "0 9 * * *", hermes_cron_id: "c1" };
    h.reply({ schedules: [sched] });

    const result = await h.client.listSchedules();

    expect(result).toEqual([sched]);
    expect(h.last().path).toBe(`${BASE}/schedules`);
  });

  it("pauses, resumes, and runs a schedule via POST", async () => {
    const h = harness();
    h.reply({ ok: true });

    await h.client.pauseSchedule("c1");
    expect(h.last().path).toBe(`${BASE}/schedules/c1/pause`);
    expect(h.last().init?.method).toBe("POST");

    await h.client.resumeSchedule("c1");
    expect(h.last().path).toBe(`${BASE}/schedules/c1/resume`);

    await h.client.runScheduleNow("c1");
    expect(h.last().path).toBe(`${BASE}/schedules/c1/run`);
    expect(h.last().init?.method).toBe("POST");
  });

  it("edits a schedule's cron via PUT, forwarding the expression", async () => {
    const h = harness();
    h.reply({ ok: true, cron_expression: "30 7 * * *" });

    await h.client.editSchedule("c1", "30 7 * * *");

    const call = h.last();
    expect(call.path).toBe(`${BASE}/schedules/c1`);
    expect(call.init?.method).toBe("PUT");
    expect(new Headers(call.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual({ cron: "30 7 * * *" });
  });

  it("deletes a schedule via DELETE", async () => {
    const h = harness();
    h.reply({ deleted: true });

    const result = await h.client.deleteSchedule("c1");

    expect(result).toEqual({ deleted: true });
    expect(h.last().path).toBe(`${BASE}/schedules/c1`);
    expect(h.last().init?.method).toBe("DELETE");
  });

  it("gets settings, returning values and schema", async () => {
    const h = harness();
    const payload = {
      values: { default_mode: "durable", fail_open: true },
      schema: { namespace: "plugins.workflows", groups: [] },
    };
    h.reply(payload);

    const result = await h.client.getSettings();

    expect(result).toBe(payload);
    expect(h.last().path).toBe(`${BASE}/settings`);
    expect(h.last().init?.method ?? "GET").toBe("GET");
  });

  it("saves settings via PUT, forwarding the values map", async () => {
    const h = harness();
    h.reply({
      values: { internal_board: "b2" },
      schema: { namespace: "plugins.workflows", groups: [] },
    });

    await h.client.saveSettings({ internal_board: "b2", fail_open: false });

    const call = h.last();
    expect(call.path).toBe(`${BASE}/settings`);
    expect(call.init?.method).toBe("PUT");
    expect(new Headers(call.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual({ internal_board: "b2", fail_open: false });
  });

  it("reads the O2B status badge (connected + installed)", async () => {
    const h = harness();
    h.reply({ connected: true, installed: true });
    expect(await h.client.o2bStatus()).toEqual({ connected: true, installed: true });
    expect(h.last().path).toBe(`${BASE}/o2b-status`);
  });

  it("lists host skills by name from /api/skills", async () => {
    const h = harness();
    h.reply([{ name: "github" }, { name: "" }, { other: 1 }, { name: "email" }]);
    expect(await h.client.listSkills()).toEqual(["github", "email"]);
    expect(h.last().path).toBe("/api/skills");
  });

  it("rejects a malformed /api/skills payload instead of coercing to empty", async () => {
    const h = harness();
    h.reply({ not: "an array" });
    // Import normalization treats a fulfilled result as a verified catalogue, so
    // a garbage payload must fail (→ unverified) rather than strip every skill.
    await expect(h.client.listSkills()).rejects.toThrow(/expected an array/i);
  });

  it("creates a workflow with a JSON POST to the collection route", async () => {
    const h = harness();
    const body = { workflow: { id: "fresh" }, ui: { xyflow: { nodes: [] } } } as never;
    const created = { workflow: { id: "fresh" }, path: "/x/fresh.workflow.yaml" };
    h.reply(created);

    const result = await h.client.createWorkflow(body);

    expect(result).toBe(created);
    const call = h.last();
    expect(call.path).toBe(`${BASE}/workflows`);
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual(body);
  });

  it("deletes a workflow via DELETE, encoding the id", async () => {
    const h = harness();
    h.reply({ deleted: true });

    const result = await h.client.deleteWorkflow("a/b");

    expect(result).toEqual({ deleted: true });
    const call = h.last();
    expect(call.path).toBe(`${BASE}/workflows/a%2Fb`);
    expect(call.init?.method).toBe("DELETE");
  });

  it("exports a workflow, returning the YAML envelope", async () => {
    const h = harness();
    const envelope = { id: "wf-1", filename: "wf-1.workflow.yaml", yaml: "id: wf-1\n" };
    h.reply(envelope);

    const result = await h.client.exportWorkflow("wf-1");

    expect(result).toBe(envelope);
    expect(h.last().path).toBe(`${BASE}/workflows/wf-1/export`);
    expect(h.last().init?.method ?? "GET").toBe("GET");
  });

  it("exports a workflow as a template, returning the bundle envelope", async () => {
    const h = harness();
    const envelope = {
      id: "wf-1",
      cached: false,
      revision: "9c3a0000",
      human_version: "fmt1·wf1·r9c3a",
      spec_sha: "sha256:00",
      yaml_filename: "wf-1.template.yaml",
      yaml: "id: wf-1\n",
      md_filename: "wf-1.template.md",
      md: "# guide\n",
    };
    h.reply(envelope);

    const result = await h.client.exportTemplate("wf-1");

    expect(result).toBe(envelope);
    expect(h.last().path).toBe(`${BASE}/workflows/wf-1/export-template`);
    expect(h.last().init?.method ?? "GET").toBe("GET");
  });
});
