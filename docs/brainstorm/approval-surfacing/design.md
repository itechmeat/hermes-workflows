# Pending command-approval surfacing — approval state in the telemetry sidecar

**Status:** accepted
**Author:** Sol Aitken (via feature-release-playbook)
**Audience:** implementation

## Problem statement

When a worker executing an `agent_task` node hits a dangerous-command approval
prompt, the workflow run sits in `running` with no explanation. From the run
inspector it is indistinguishable from a slow worker; the operator gets no cue
that a human response is needed on another surface (CLI/gateway).

## Scope

- `pre_approval_request` / `post_approval_response` observer callbacks in the
  same worker-side observer module the telemetry task adds, gated by the same
  `HERMES_KANBAN_TASK` env join.
- Approval state stored as an `approval` field inside the per-task telemetry
  sidecar: `pre_approval_request` sets
  `{state: "pending", command, description, surface, requested_at}`;
  `post_approval_response` updates it to
  `{state: "resolved", choice, resolved_at}` (command/description retained).
- Inspector surfacing: a "waiting for command approval" annotation (with the
  command text) on the node detail and a badge on the node card while the node
  is active and its live telemetry shows a pending approval; deny / timeout
  choices stay visible in the node detail after settle (baked into
  `NodeRunState.telemetry.approval`).
- No behavior change to approvals (observer-only by contract).

## Out of scope

- Threshold-based notification pings to the run's origin chat (the optional
  scope in the task body) — deferred until prioritized; the notification path
  and idempotency markers it would use already exist.
- Vetoing/pre-answering approvals (forbidden by the host contract).
- Approval surfacing for non-kanban nodes (no env join exists).

## Chosen approach

Variant 1 of the consultant round (see `variants.md`): reuse the telemetry
channel. With one adjustment made when the sibling task's design settled on
aggregate sidecars instead of event journals: the approval state is a struct
field in the same sidecar JSON, not a pair of folded events. The
pending/resolved question is answered by the latest sidecar write (last write
wins), which removes the consultant's noted con about deriving presence from an
event fold — there is no fold.

## Design decisions

- **Same join, same channel, no new plumbing.** The approval callbacks write
  through the same `NodeTelemetryRecorder`; the dashboard live overlay and the
  engine settle-merge pick the field up with zero approval-specific transport.
- **Pending is only ever rendered for active nodes.** The UI shows the
  annotation when node status is `scheduled` / `running` and
  `telemetry.approval.state == "pending"`. A worker that dies mid-prompt leaves
  a pending record in the baked telemetry, but the node is then terminal, so no
  phantom "waiting" annotation can persist (the stale-marker failure mode of
  the rejected variant 2).
- **Deny / timeout context survives.** The resolved record (with `choice`)
  is baked into `NodeRunState.telemetry.approval` at settle, so a node failure
  that follows a denied or timed-out command is explainable after the fact —
  the acceptance requirement.
- **`session_key` is recorded but not parsed.** Verified on the installed host:
  approval hook kwargs carry no task identity and the session key does not
  embed the card id; the env join is the correlation. The key is kept in the
  record as opaque context only.
- **Fail-open.** Both callbacks ride the host's fail-open `invoke_hook` and the
  recorder's swallow-all write path; an approval-recording bug can suppress the
  annotation, never affect the approval flow or the run.

## File changes

(Working on top of the observer-telemetry tasks; only deltas listed.)

Modified:
- `hermes_workflows/observer.py` — `pre_approval_request` /
  `post_approval_response` callbacks; registered behind the same env gate.
- `hermes_workflows/telemetry.py` — `approval` field on the aggregate
  (`record_approval_request` / `record_approval_response`).
- `packages/core/src/schema/run.ts` — `approval` member on `NodeTelemetry`.
- `apps/dashboard/src/run/RunInspector.tsx` — pending annotation + resolved
  deny/timeout note in node detail.
- `apps/dashboard/src/run/{runView.ts,RunNodeView.tsx}` — pending-approval badge
  on the node card (data attribute + CSS).
- `apps/dashboard/src/ui/theme.css` — badge styling.
- Tests: `tests/python/test_observer.py`, `tests/python/test_telemetry.py`,
  dashboard run-inspector test.

## Risks and open questions

- **CLI-surface approvals** (`surface: "cli"`) inside a kanban worker are
  unlikely (workers are non-interactive) but recorded identically if they occur.
- **Repeated approvals in one node**: the single `approval` field holds the most
  recent request/response — sufficient for "is it waiting now" and "what
  resolved last"; a per-approval history is deliberately not kept (KISS).
- **Timeout clears via the host**: gateway approvals time out (default 300s)
  and fire `post_approval_response` with `choice: "timeout"`, so a pending
  record cannot outlive the prompt while the worker is alive.
