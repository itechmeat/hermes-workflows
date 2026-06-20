// Attach → start → poll → hand-off state machine behind the editor's Play
// button, split from FlowEditor so the flow is unit-testable through a mocked
// WorkflowsApi. On mount the hook checks for an already-active run of this
// workflow (single-flight guarantees at most one) and, when found, enters
// playback attached to it — returning to the page never pretends the workflow
// is idle. The hook only orchestrates the run: the save-before-play gate stays
// in the editor (it owns the dirty state), and navigation is delegated to
// `onHandOff`. Every failure is exposed via `error` — never swallowed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowsApi } from "../api/client";
import type { RunState, RunSummary, RunOptions } from "../api/types";
import type { ParamValue } from "@hermes-workflows/core/templates/params.ts";
import { shouldHandOff } from "../run/runView";
import { errorMessage, RUN_POLL_MS, useRunPolling } from "../run/useRunPolling";

export type PlaybackPhase = "attaching" | "idle" | "starting" | "playing";

export interface RunPlayback {
  phase: PlaybackPhase;
  /** Live state of the playing run; null until the first poll lands. */
  run: RunState | null;
  /** Attach, start, or poll failure, surfaced to the operator. */
  error: string | null;
  /** Start the run, optionally with a free-form operator input layered above
   *  every agent_task prompt at highest priority, and resolved template params
   *  substituted into node prompts. Ignored unless the playback is idle
   *  (double-start guard; also inert while the mount attach check is pending). */
  play: (input?: string, params?: Record<string, ParamValue>) => void;
}

export function useRunPlayback(options: {
  api: WorkflowsApi;
  workflowId: string;
  /** Navigate to the run inspector; called exactly once per playback. */
  onHandOff: (runId: string) => void;
  /** Whether playback is wired up at all (the editor only enables it when the
   *  inspector navigation exists). Disabled skips the mount attach check. */
  enabled?: boolean;
  pollMs?: number;
}): RunPlayback {
  const { api, workflowId, onHandOff, enabled = true, pollMs = RUN_POLL_MS } = options;
  const [phase, setPhase] = useState<PlaybackPhase>(enabled ? "attaching" : "idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // Ref, not state: the hand-off must fire exactly once even if a poll result
  // lands between the navigation call and the editor unmounting.
  const handedOff = useRef(false);
  // The play() failure continuation resolves outside any effect; this ref lets
  // it skip setState after the editor unmounted (same guard the mount attach
  // effect gets from its own `disposed` flag).
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const { run, pollError } = useRunPolling(api, phase === "playing" ? runId : null, pollMs);

  const handOff = useCallback(
    (id: string) => {
      handedOff.current = true;
      onHandOff(id);
    },
    [onHandOff],
  );

  /** The workflow's active run, if any — newest first per the runs API. */
  const findActiveRun = useCallback(
    (): Promise<RunSummary | undefined> =>
      api.listRuns("active", workflowId).then((summaries) => summaries[0]),
    [api, workflowId],
  );

  /** Enter playback on an existing active run (or hand a parked one straight
   *  to the inspector — only it has review controls). */
  const adopt = useCallback(
    (active: RunSummary): void => {
      if (shouldHandOff(active.status)) {
        handOff(active.run_id);
        return;
      }
      setRunId(active.run_id);
      setPhase("playing");
    },
    [handOff],
  );

  // Mount attach check: the page must reflect a run that is already in flight.
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    findActiveRun()
      .then((active) => {
        if (disposed) return;
        if (active === undefined) {
          setPhase("idle");
          return;
        }
        adopt(active);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // Unknown state — unlock Play (the server guard still protects the
        // single-flight invariant) but say loudly that the check failed.
        setPhase("idle");
        setStartError(`Active-run check failed: ${errorMessage(error)}`);
      });
    return () => {
      disposed = true;
    };
  }, [enabled, findActiveRun, adopt]);

  // Watch polled state for the moment the run settles (or parks in review).
  const status = run?.status;
  useEffect(() => {
    if (runId === null || status === undefined || handedOff.current) return;
    if (shouldHandOff(status)) handOff(runId);
  }, [runId, status, handOff]);

  const play = useCallback(
    (input?: string, params?: Record<string, ParamValue>) => {
      if (phase !== "idle") return;
      setPhase("starting");
      setStartError(null);
      // Only send options when there is something to send: a bare start keeps
      // the single-arg call shape the run endpoint and the rest of the surface
      // already expect.
      const trimmed = input?.trim();
      const options: RunOptions = {};
      if (trimmed) options.input = trimmed;
      if (params && Object.keys(params).length > 0) options.params = params;
      const startCall =
        Object.keys(options).length > 0
          ? api.runWorkflow(workflowId, options)
          : api.runWorkflow(workflowId);
      startCall
        .then((started) => {
          // A fast run can already be settled in the start response — hand over
          // immediately instead of stalling on a poll that would never observe
          // an active state.
          if (shouldHandOff(started.status)) {
            handOff(started.run_id);
            return;
          }
          setRunId(started.run_id);
          setPhase("playing");
        })
        .catch((error: unknown) => {
          const startMessage = `Run failed to start: ${errorMessage(error)}`;
          setStartError(startMessage);
          // A refused start may mean another surface holds the active run
          // (single-flight 409) — re-check and adopt it so the canvas shows the
          // real state alongside the refusal.
          findActiveRun()
            .then((active) => {
              if (!mounted.current) return;
              if (active === undefined) {
                setPhase("idle");
                return;
              }
              adopt(active);
            })
            .catch((checkError: unknown) => {
              if (!mounted.current) return;
              setPhase("idle");
              setStartError(
                `${startMessage}; active-run check also failed: ${errorMessage(checkError)}`,
              );
            });
        });
    },
    [api, workflowId, phase, handOff, findActiveRun, adopt],
  );

  return { phase, run, error: startError ?? pollError, play };
}
