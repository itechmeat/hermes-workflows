/**
 * Compile a workflow into a deterministic preview of the Hermes primitives it
 * would create. Pure: no side effects, no I/O. This powers the dashboard
 * "compile preview" and the `compile-preview` CLI command.
 */

import type { Workflow, Trigger, MemoryProviderKind, Scope } from "../schema/workflow.ts";
import type { WaitCondition } from "../schema/nodes.ts";
import { entryNodes } from "../schema/graph.ts";
import { catalogEntry } from "../templates/params.ts";
import type { WorkflowParam, CatalogEntry } from "../templates/params.ts";

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
  /** Authored text from a Prompt node feeding this task (an edge
   *  `prompt -> agent_task`). The engine layers it ABOVE the resolved prompt as
   *  the primary instruction, the same way the operator's run `--input` layers.
   *  Absent when no Prompt node feeds this task. */
  node_prompt?: string;
  model?: string;
  skills?: string[];
  workspace?: "scratch" | "worktree";
  timeout_seconds?: number;
  max_retries?: number;
  /** Drive an existing card instead of creating one (see AgentTaskNode.adopt). */
  adopt?: boolean;
  /** The id (or `{{nodes.<id>.output.task_ids}}` reference) to drive when adopting. */
  task_ref?: string;
  /** Reviewer profile for a native review stage on a driven card (see AgentTaskNode). */
  review_profile?: string;
  /** Drive adopted cards one at a time on a shared branch (see AgentTaskNode.sequential). */
  sequential?: boolean;
  /** Stack a multi-card adopt scope on a shared feature branch (see AgentTaskNode.stack). */
  stack?: boolean;
  /** The shared feature branch a stacked adopt drives onto (see AgentTaskNode.branch). */
  branch?: string;
  /** Release working tree for a stacked adopt (see AgentTaskNode.workdir). */
  workdir?: string;
  /** Per-node override of the per-card completion subscription; unset inherits
   *  the workflow-level `subscribe_cards` (see AgentTaskNode.notify_completion). */
  notify_completion?: boolean;
  /** Run this node OFF the board (no Kanban card), via the direct profile
   *  runner, so internal orchestration steps do not clutter the operator's
   *  board (see AgentTaskNode.board). Set only when the node opted out with
   *  `board: false`; absent means the node creates a card as before. */
  off_board?: boolean;
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

/** A wait node compiled for worker-free polling by the engine tick. Peer of
 *  CompiledKanbanTask / CompiledScript; routed by the `kind` discriminator. */
export interface CompiledWait {
  node: string;
  kind: "wait";
  wait_for: WaitCondition;
  timeout_seconds?: number;
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
  /** Where the run result is delivered (DeliveryTarget syntax or "origin");
   *  absent leaves run-lifecycle notices unchanged. Preview only — the engine
   *  reads this to route the terminal notice; the gateway validates it. */
  deliver?: string;
  /** Whether Kanban-backed node cards subscribe the origin to their terminal
   *  events (the native per-card "done" ping). Defaults true; a spec opts out. */
  subscribe_cards: boolean;
  /** Typed template parameters (when this workflow is a template). */
  params?: WorkflowParam[];
  /** The per-surface renderings (form fields, /workflow command, deep-link)
   *  derived from `params` — present only when the workflow declares params. */
  catalog?: CatalogEntry;
  first_node: string | null;
  kanban_tasks: CompiledKanbanTask[];
  script_steps: CompiledScript[];
  wait_steps: CompiledWait[];
  cron_jobs: CompiledCronJob[];
  profiles: string[];
  skills: string[];
  memory: { provider: MemoryProviderKind; fail_open: boolean };
}

export function compileToHermesPlan(workflow: Workflow): HermesPlan {
  const defaultProfile = workflow.defaults?.profile;

  const kanban_tasks: CompiledKanbanTask[] = [];
  const script_steps: CompiledScript[] = [];
  const wait_steps: CompiledWait[] = [];
  const profiles = new Set<string>();
  const skills = new Set<string>();

  const defaultRetries = workflow.defaults?.max_retries;

  // A Prompt node does no work; its authored text is a PRIMARY INSTRUCTION for
  // every agent_task DOWNSTREAM of it — from where it is embedded onward,
  // following edges transitively, not merely its immediate successor. A Prompt
  // node may sit anywhere in any workflow; an empty one (no text) is a pass-
  // through no-op and contributes nothing. When several Prompt nodes reach the
  // same task their texts join in node-declaration order. Resolve the per-target
  // text here so the engine layers it at schedule time.
  const promptNodeText = new Map<string, string>();
  for (const node of workflow.nodes) {
    if (node.type === "prompt" && node.prompt) promptNodeText.set(node.id, node.prompt);
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const outs = adjacency.get(edge.from) ?? [];
    outs.push(edge.to);
    adjacency.set(edge.from, outs);
  }
  const nodePromptByTarget = new Map<string, string>();
  // Iterate Prompt nodes in declaration order so a task reached by several gets
  // their texts in a stable order. For each, walk everything reachable downstream
  // and layer its text onto each node once (the seen-set also breaks cycles).
  for (const node of workflow.nodes) {
    const text = promptNodeText.get(node.id);
    if (text === undefined) continue;
    const seen = new Set<string>([node.id]);
    const queue = [...(adjacency.get(node.id) ?? [])];
    while (queue.length > 0) {
      const target = queue.shift() as string;
      if (seen.has(target)) continue;
      seen.add(target);
      const prev = nodePromptByTarget.get(target);
      nodePromptByTarget.set(target, prev === undefined ? text : `${prev}\n\n${text}`);
      for (const next of adjacency.get(target) ?? []) queue.push(next);
    }
  }

  for (const node of workflow.nodes) {
    if (node.type === "script") {
      const step: CompiledScript = { node: node.id, kind: "script", command: node.command };
      if (node.workdir !== undefined) step.workdir = node.workdir;
      if (node.timeout_seconds !== undefined) step.timeout_seconds = node.timeout_seconds;
      if (node.env !== undefined) step.env = node.env;
      script_steps.push(step);
      continue;
    }
    if (node.type === "wait") {
      const step: CompiledWait = { node: node.id, kind: "wait", wait_for: node.wait_for };
      if (node.timeout_seconds !== undefined) step.timeout_seconds = node.timeout_seconds;
      wait_steps.push(step);
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
    const nodePrompt = nodePromptByTarget.get(node.id);
    if (nodePrompt !== undefined) task.node_prompt = nodePrompt;
    // `board: false` runs the node off the project board (no card); carried as
    // a positive flag so an absent value never reads as off-board downstream.
    if (node.board === false) task.off_board = true;
    if (node.adopt !== undefined) task.adopt = node.adopt;
    if (node.task_ref !== undefined) task.task_ref = node.task_ref;
    if (node.review_profile !== undefined) task.review_profile = node.review_profile;
    if (node.sequential !== undefined) task.sequential = node.sequential;
    if (node.stack !== undefined) task.stack = node.stack;
    if (node.branch !== undefined) task.branch = node.branch;
    if (node.workdir !== undefined) task.workdir = node.workdir;
    if (node.notify_completion !== undefined) task.notify_completion = node.notify_completion;
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

  // A workflow used as a template emits its per-surface catalog from one schema.
  const catalog =
    workflow.params !== undefined
      ? catalogEntry({
          key: workflow.id,
          title: workflow.name,
          description: "",
          params: workflow.params,
        })
      : undefined;

  return {
    workflow_id: workflow.id,
    scope: workflow.scope,
    trigger: workflow.trigger,
    ...(workflow.deliver !== undefined ? { deliver: workflow.deliver } : {}),
    subscribe_cards: workflow.notifications?.subscribe_cards ?? true,
    ...(workflow.params !== undefined ? { params: workflow.params } : {}),
    ...(catalog !== undefined ? { catalog } : {}),
    first_node: entry ? entry.id : null,
    kanban_tasks,
    script_steps,
    wait_steps,
    cron_jobs,
    profiles: [...profiles],
    skills: [...skills],
    memory: {
      provider: workflow.defaults?.memory?.provider ?? "auto",
      fail_open: workflow.defaults?.memory?.fail_open ?? true,
    },
  };
}
