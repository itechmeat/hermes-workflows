# workflow-run-followups - brainstorm variants and decisions

Consultant: Claude Code (`claude -p`), single consolidated call over the four
open architectural questions of the 2026-06-14 triage batch. Raw output:
`cli-output/claude.md` (verbatim, three variants + a recommendation per question).
Codex fallback was not needed (primary returned a complete, parseable set).

The other nine tasks in the batch are mechanical or fully scoped by their task
bodies (icons, read-only inspector, gate-entry notice, chat-reply documentation,
cancel CLI, HOME contract) and did not need a variant search; their design is in
`design.md`.

## Orchestrator decisions

### Q1 - Drive an existing Kanban card (t_797d3917, t_0de31c59)
**Adopted: Variant 2** (additive `adopt` flag + `task_ref`, typed
`{{nodes.X.output.task_ids}}` channel). Agreed with the consultant: it fails loud
on a missing/empty id list (no free-text parsing footgun), keeps one node type so
`profile` routing and the poll path stay shared, and the typed sub-channel is the
same mechanism Q2 reuses. Variant 1's free-text id parsing violates the loud-
failure rule; Variant 3's dedicated node type duplicates routing/poll wiring.

### Q2 - human_review operator-input payload (t_f6e62787)
**Adopted: Variant 2** (additive `review_payload` = note + optional option,
exposed via `{{nodes.<gate>.review_note}}` and `{{nodes.<gate>.review_option}}`).
Agreed: covers both the free-text note and a structured choice, purely additive,
never touches the existing single-channel `.output` contract or `review_decision`
meaning, and reuses the per-node named-token grammar from Q1.

### Q3 - Spec serialization formatting (t_896520df)
**Override: Variant 1** (block scalars in the serializer), not the consultant's
Variant 2 (read-only authored file).
Rationale: the dashboard is the primary authoring surface and its Save path MUST
write the file - so "never overwrite the author's file" cannot hold in general;
any save normalizes it. The change that actually keeps a hand-authored prompt
readable across BOTH the Save path and a run is emitting `|` block scalars for
multiline strings. Losslessness is preserved by choosing the chomping indicator
(`|`/`|-`/`|+`) from the string's trailing newlines and falling back to the
existing JSON-quoted scalar for any string that cannot be represented cleanly as
a block (trailing spaces, leading indentation, no newline). Comments are not
round-tripped (YAML comment preservation is fragile, as the consultant notes) -
documented as a known limit. We also confirm no unnecessary run-start rewrite of
the authored file beyond the legitimate save path.

### Q4 - Blocked cards + status freshness (t_b5b5f772, t_0c352b34)
**Adopted with refinement: Variant 1** (surface + notify via the native router;
label freshness), refined to NOT force the run into `waiting`.
Rationale: run_status is owned by the pure TypeScript engine and is derived from
node statuses; a `blocked` underlying card still leaves an active node, so the
run correctly stays `running` and the tick keeps ticking (it auto-recovers when
the card is unblocked). Injecting a `waiting` state from the Python side would
fight the engine. So the Python tick detects a blocked/stalled polled card,
records an additive per-card attention marker on the run, and delivers ONE
operator notice per blocked card (idempotent via the existing `notified`
markers), exactly the no-silent-inert behaviour the task asks for, without
diverging from the engine's run-state machine.
For freshness (t_0c352b34): `status` is a manual operator command, not the hot
tick path, so it opportunistically does a read-only live poll of each active
node's card and annotates the printed state with the live card status + a
"pending completion" flag. This directly kills the "looks stuck" confusion; the
per-call I/O cost is irrelevant for a manual command (consultant preferred
labels-only to avoid I/O on the tick path, which does not apply to a manual
status read).

### t_d351a2aa - Native review stage for driven cards
Extends Q1's adopt mode with an optional `review_profile`: after a driven card
reaches `done`, the executor transitions it `done`->`review`-equivalent by
re-opening it through the native `claim_review_task` path with the reviewer
assignee, and the node settles only when the review reaches terminal. Built
natively on `kanban_db.claim_review_task` / `review` status; optional, so
workflows that do not need it are unaffected.
