// Start → poll → hand-off state machine behind the editor's Play button, split
// from FlowEditor so the flow is unit-testable through a mocked WorkflowsApi.
// The hook only orchestrates the run: the save-before-play gate stays in the
// editor (it owns the dirty state), and navigation is delegated to `onHandOff`.
// Every failure is exposed via `error` — never swallowed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowsApi } from "../api/client";
import type { RunState } from "../api/types";
import { shouldHandOff } from "../run/runView";
import { errorMessage, RUN_POLL_MS, useRunPolling } from "../run/useRunPolling";

export type PlaybackPhase = "idle" | "starting" | "playing";

export interface RunPlayback {
  phase: PlaybackPhase;
  /** Live state of the playing run; null until the first poll lands. */
  run: RunState | null;
  /** Start or poll failure, surfaced to the operator. */
  error: string | null;
  /** Start the run. Ignored unless the playback is idle (double-start guard). */
  play: () => void;
}

export function useRunPlayback(options: {
  api: WorkflowsApi;
  workflowId: string;
  /** Navigate to the run inspector; called exactly once per playback. */
  onHandOff: (runId: string) => void;
  pollMs?: number;
}): RunPlayback {
  const { api, workflowId, onHandOff, pollMs = RUN_POLL_MS } = options;
  const [phase, setPhase] = useState<PlaybackPhase>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // Ref, not state: the hand-off must fire exactly once even if a poll result
  // lands between the navigation call and the editor unmounting.
  const handedOff = useRef(false);

  const { run, pollError } = useRunPolling(api, phase === "playing" ? runId : null, pollMs);

  const handOff = useCallback(
    (id: string) => {
      handedOff.current = true;
      onHandOff(id);
    },
    [onHandOff],
  );

  // Watch polled state for the moment the run settles (or parks in review).
  const status = run?.status;
  useEffect(() => {
    if (runId === null || status === undefined || handedOff.current) return;
    if (shouldHandOff(status)) handOff(runId);
  }, [runId, status, handOff]);

  const play = useCallback(() => {
    if (phase !== "idle") return;
    setPhase("starting");
    setStartError(null);
    api
      .runWorkflow(workflowId)
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
        setPhase("idle");
        setStartError(`Run failed to start: ${errorMessage(error)}`);
      });
  }, [api, workflowId, phase, handOff]);

  return { phase, run, error: startError ?? pollError, play };
}
