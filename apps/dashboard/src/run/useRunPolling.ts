// Shared poll loop for a workflow run: one immediate load, then a fixed-cadence
// re-fetch that stops on its own once the run reaches a terminal status. Both
// run surfaces (the run inspector and editor playback) consume this hook so
// there is exactly one polling behavior to test and reason about. Failures are
// exposed as state — never swallowed — and the next successful poll clears them.
import { useEffect, useState } from "react";
import type { WorkflowsApi } from "../api/client";
import type { RunState } from "../api/types";
import { isTerminalRun } from "./runView";

/** Poll cadence both run surfaces use while a run is active. */
export const RUN_POLL_MS = 2000;

/** Human-readable message for an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RunPollingState {
  /** Latest run state; null until the first successful load. */
  run: RunState | null;
  /** Most recent load/poll failure, cleared by the next successful poll. */
  pollError: string | null;
  /** Replace local state after a mutating action (cancel / retry response). */
  replaceRun: (run: RunState) => void;
}

/** Poll `runId` every `pollMs` while it is active. Pass `runId: null` to keep
 *  the hook mounted but idle (playback before a run starts). */
export function useRunPolling(
  api: WorkflowsApi,
  runId: string | null,
  pollMs: number = RUN_POLL_MS,
): RunPollingState {
  const [run, setRun] = useState<RunState | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  // Reset on retarget so a previous run never bleeds into the next one.
  useEffect(() => {
    setRun(null);
    setPollError(null);
  }, [api, runId]);

  // `active` collapses run-state changes into one boolean so the interval is
  // torn down exactly when polling should stop, not on every poll result.
  const active = runId !== null && (run === null || !isTerminalRun(run.status));

  useEffect(() => {
    if (runId === null || !active) return undefined;
    let disposed = false;
    const poll = (): void => {
      api
        .getRun(runId)
        .then((loaded) => {
          if (disposed) return;
          setRun(loaded);
          setPollError(null);
        })
        .catch((error: unknown) => {
          if (!disposed) setPollError(errorMessage(error));
        });
    };
    poll();
    const handle = setInterval(poll, pollMs);
    return () => {
      disposed = true;
      clearInterval(handle);
    };
  }, [api, runId, active, pollMs]);

  return { run, pollError, replaceRun: setRun };
}
