/**
 * Compile a workflow into a deterministic preview of the Hermes primitives it
 * would create. Pure: no side effects, no I/O. This powers the dashboard
 * "compile preview" and the `compile-preview` CLI command.
 */

import type { Workflow, Trigger, MemoryProviderKind, Scope } from "../schema/workflow.ts";
import { entryNodes } from "../schema/graph.ts";

export interface CompiledKanbanTask {
  node: string;
  /** Discriminator so the engine routes scheduling by node kind. */
  kind: "agent";
  assignee: string;
  workflow_template_id: string;
  current_step_key: string;
  /** Everything the bridge needs to create the card — the engine is the single
   *  interpreter of the spec; the Python orchestrator just executes this. */
  title?: string;
  prompt: string;
  /** Placeholder -> `{{nodes.<id>.output}}` references the engine resolves into
   *  the prompt at schedule time. Carried verbatim; the engine substitutes. */
  input_mapping?: Record<string, string>;
  model?: string;
  skills?: string[];
  workspace?: "scratch" | "worktree";
  timeout_seconds?: number;
  max_retries?: number;
}

/** A script node compiled for local execution by the plugin's ScriptExecutor.
 *  Peer of `CompiledKanbanTask`; the `kind` discriminator routes scheduling. */
export interface CompiledScript {
  node: string;
  kind: "script";
  command: string;
  workdir?: string;
  timeout_seconds?: number;
  env?: string[];
}

export interface CompiledCronJob {
  schedule: string;
  timezone?: string;
  command: string;
}

export interface HermesPlan {
  workflow_id: string;
  scope: Scope;
  trigger: Trigger;
  first_node: string | null;
  kanban_tasks: CompiledKanbanTask[];
  script_steps: CompiledScript[];
  cron_jobs: CompiledCronJob[];
  profiles: string[];
  skills: string[];
  memory: { provider: MemoryProviderKind; fail_open: boolean };
}

export function compileToHermesPlan(workflow: Workflow): HermesPlan {
  const defaultProfile = workflow.defaults?.profile;

  const kanban_tasks: CompiledKanbanTask[] = [];
  const script_steps: CompiledScript[] = [];
  const profiles = new Set<string>();
  const skills = new Set<string>();

  const defaultRetries = workflow.defaults?.max_retries;

  for (const node of workflow.nodes) {
    if (node.type === "script") {
      const step: CompiledScript = { node: node.id, kind: "script", command: node.command };
      if (node.workdir !== undefined) step.workdir = node.workdir;
      if (node.timeout_seconds !== undefined) step.timeout_seconds = node.timeout_seconds;
      if (node.env !== undefined) step.env = node.env;
      script_steps.push(step);
      continue;
    }
    if (node.type !== "agent_task") continue;
    const assignee = node.profile ?? defaultProfile ?? "";
    const task: CompiledKanbanTask = {
      node: node.id,
      kind: "agent",
      assignee,
      workflow_template_id: workflow.id,
      current_step_key: node.id,
      prompt: node.prompt,
    };
    if (node.title !== undefined) task.title = node.title;
    if (node.input_mapping !== undefined) task.input_mapping = node.input_mapping;
    if (node.model !== undefined) task.model = node.model;
    if (node.skills !== undefined) task.skills = node.skills;
    if (node.workspace !== undefined) task.workspace = node.workspace.type;
    if (node.timeout_seconds !== undefined) task.timeout_seconds = node.timeout_seconds;
    const retries = node.max_retries ?? defaultRetries;
    if (retries !== undefined) task.max_retries = retries;
    kanban_tasks.push(task);
    if (assignee) profiles.add(assignee);
    for (const skill of node.skills ?? []) skills.add(skill);
  }

  const cron_jobs: CompiledCronJob[] =
    workflow.trigger.type === "cron"
      ? [
          {
            schedule: workflow.trigger.schedule,
            ...(workflow.trigger.timezone !== undefined
              ? { timezone: workflow.trigger.timezone }
              : {}),
            command: `hermes-workflows run ${workflow.id}`,
          },
        ]
      : [];

  const entry = entryNodes(workflow)[0];

  return {
    workflow_id: workflow.id,
    scope: workflow.scope,
    trigger: workflow.trigger,
    first_node: entry ? entry.id : null,
    kanban_tasks,
    script_steps,
    cron_jobs,
    profiles: [...profiles],
    skills: [...skills],
    memory: {
      provider: workflow.defaults?.memory?.provider ?? "auto",
      fail_open: workflow.defaults?.memory?.fail_open ?? true,
    },
  };
}
