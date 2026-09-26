import {
  onNewerSchemaRefusal,
  PERSISTED_STORES,
  type NewerSchemaError,
  type PersistedStore,
} from "../utils/PersistedSchemaGuard";

/** Exit code for "a newer ctrlyoke owns this state; update to modify it". */
export const NEWER_SCHEMA_EXIT_CODE = 2;

/**
 * Stores whose refusal means the run itself could not proceed. Other refusals
 * (usage statistics, the advisory coordination board) are swallowed by their
 * callers and say nothing about why a run ended.
 */
const RUN_STATE_STORES: ReadonlySet<PersistedStore> = new Set([
  PERSISTED_STORES.WORKFLOW_DEFINITION,
  PERSISTED_STORES.RUN_FILE,
  PERSISTED_STORES.LINEAGE_DESCRIPTOR,
  PERSISTED_STORES.RUNNER_LOCK,
]);

export interface RunStateRefusalTracker {
  /** The first run-state refusal seen, if any. */
  first(): NewerSchemaError | undefined;
  dispose(): void;
}

/**
 * Record refused writes to run state. A refusal mid-run is caught by the
 * executor and reported as a failed step, so without this the CLI would exit
 * `1` ("workflow failed") instead of `2` ("update ctrlyoke").
 */
export function trackRunStateRefusals(): RunStateRefusalTracker {
  let first: NewerSchemaError | undefined;
  const dispose = onNewerSchemaRefusal((error) => {
    if (RUN_STATE_STORES.has(error.store)) {
      first ??= error;
    }
  });
  return { first: () => first, dispose };
}

/**
 * A run that did not succeed and saw a run-state refusal exits with
 * {@link NEWER_SCHEMA_EXIT_CODE}. A successful run keeps `0`.
 */
export function applyRunStateRefusal(
  exitCode: number,
  refusal: NewerSchemaError | undefined
): number {
  return exitCode !== 0 && refusal ? NEWER_SCHEMA_EXIT_CODE : exitCode;
}
