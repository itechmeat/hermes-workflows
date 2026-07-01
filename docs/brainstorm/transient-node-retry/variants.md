# TRANSIENT-NODE-RETRY — variants

How should the Kanban path ride out a transient provider blip that the worker
surfaced on a clean exit (so native card retry never fires)?

## A. Native card `max_retries` (rejected)

Rely on the dispatcher's own `max_retries` column. Rejected: the worker exits 0,
so the dispatcher records success and never retries. The whole failure mode is
that native retry is blind to an exit-0 transient. No engine change would make
this fire.

## B. Retry inside `read_completion` / the executor (rejected)

Have the Kanban executor re-dispatch on a transient poll. Rejected: the executor
is a thin, stateless seam (schedule/poll); it has no run state to count attempts
or hold a backoff deadline, and the engine — not the executor — owns node
lifecycle, idempotency iteration, and durable persistence.

## C. Engine-level retry keyed on the classifier verdict (chosen)

Surface the existing `kind` verdict through `Completion`, and let the advance
engine — which already settles outcomes, owns `seq`/iteration, and persists node
state across ticks — re-schedule a transient failure with backoff before
settling. Mirrors the direct path's intent (bounded transient retry) on the path
that actually needed it, and reuses the v0.7.6 classifier verbatim. Chosen: it
puts the decision where the state and lifecycle already live, adds no new
provider calls, and fails deterministic errors fast.

## Backoff carrier

Sub-tick sleep in the engine (rejected — blocks the shared advance-all tick for
other runs) vs. a persisted `retry_after` deadline re-checked each tick (chosen —
non-blocking, and the ~tick cadence already spaces attempts generously; the
persisted deadline follows the existing `adopt_blocked_since` precedent).
