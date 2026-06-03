You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Surface pending command-approval waits in the run inspector (approval lifecycle hooks).

**Source:** hermes-agent PR #38232 — the observer contract includes approval lifecycle hooks: `pre_approval_request` (fires before a dangerous-command approval prompt is shown) and `post_approval_response` (fires with `choice`: once / session / always / deny / timeout). Observer-only; cannot answer or veto.

**Problem:** when a worker executing an `agent_task` node hits a dangerous-command approval prompt, the workflow run just sits in `running` with no explanation. From the run inspector it is indistinguishable from a slow worker; the operator has no cue that a human response is needed somewhere else (CLI/gateway surface).

**Proposal:**
- Register `pre_approval_request` / `post_approval_response` observers in `hermes_workflows/plugin.py`, correlate to the node (same join as the telemetry task — depends on it landing first).
- While an approval is pending for a node's worker, surface a "waiting for command approval" annotation on the node in RunInspector (command + description fields are in the payload).
- On `post_approval_response`, clear the annotation; on `choice: timeout` or `deny`, record it so a subsequent node failure has context.
- Optionally reuse the run-lifecycle notification path to ping the run's origin chat when an approval blocks a run beyond a threshold.

**Acceptance:** a node whose worker is blocked on an approval shows the pending-approval annotation with the command text in the run inspector; the annotation clears once the approval is answered; deny/timeout is visible in the node detail after the fact; no behavior change to approvals themselves.

# Project context

Hermes Workflows: visual workflow orchestration plugin for Hermes Agent. TS core engine on Bun + thin Python orchestrator + React 19 dashboard. The sibling telemetry task (landing FIRST in the same PR) establishes: kanban worker processes (spawned with `HERMES_KANBAN_TASK=<card id>` in env) run plugin observer callbacks that append events to per-task JSONL files under `<hermes_home>/workflows/telemetry/`; the engine aggregates them into `NodeRunState.telemetry` at node settle time; the dashboard GET /runs/{id} route overlays live (not yet settled) telemetry while the inspector polls every 2s.

Verified host facts (installed hermes-agent v0.15.1):
- `pre_approval_request` kwargs: command, description, pattern_key, pattern_keys, session_key, surface ("cli" | "gateway"). NO task_id, NO session_id.
- `post_approval_response`: same plus choice (once/session/always/deny/timeout).
- The hooks fire inside the worker process, so `os.environ["HERMES_KANBAN_TASK"]` identifies the kanban card = `NodeRunState.hermes_task_id`. That is the only reliable node join.
- Approval hook dispatch is fail-open on the host side.
- Gateway approval default timeout 300s; the worker thread blocks polling for the user's answer while firing activity heartbeats.

RunInspector today: ReactFlow graph + node rail; node detail shows status/outcome/output/error; polls GET /runs/{id} every 2s while active. RunNodeView renders a status-coloured card per node.

Conventions and constraints:
- Python stdlib only; fail-open everywhere; observer-only (no behavior change to approvals).
- The pending state is transient — it must appear while pending and clear when answered; deny/timeout must persist long enough to give a later node failure context.
- Worker process ≠ orchestrator process ≠ dashboard process; anything crossing processes goes through files or runs.db.
- The same per-task telemetry event channel from the sibling task is available (event kinds are extensible).
- Notification path exists (Engine._notify → run origin chat) with idempotency markers; threshold-based pinging is optional scope.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
