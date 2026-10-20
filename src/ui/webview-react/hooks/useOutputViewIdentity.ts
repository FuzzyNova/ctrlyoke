import { useState } from "react";

export interface OutputViewIdentityInput {
  isViewingHistory: boolean;
  /** Run address being displayed, or null for a draft/unaddressed view. */
  displayedRunRef: string | null;
}

export interface OutputViewIdentity extends OutputViewIdentityInput {
  /** Changes exactly when the output pane's rows describe a different view. */
  key: string;
  generation: number;
}

/**
 * A continuation turns the history view of a run into the live view of that
 * same run, and `promoteHistoryToLive` carries its entries over unchanged, so
 * every row keeps its key and height. Treating that as a view switch restarts
 * the non-virtual staged render from the top and paints the bottom of the
 * pane as an empty spacer under the "Rendering output…" overlay.
 */
function isContinuationPromotion(
  previous: OutputViewIdentityInput,
  next: OutputViewIdentityInput
): boolean {
  return (
    previous.isViewingHistory &&
    !next.isViewingHistory &&
    next.displayedRunRef !== null &&
    previous.displayedRunRef === next.displayedRunRef
  );
}

export function resolveOutputViewIdentity(
  previous: OutputViewIdentity | null,
  next: OutputViewIdentityInput
): OutputViewIdentity {
  if (
    previous &&
    previous.isViewingHistory === next.isViewingHistory &&
    previous.displayedRunRef === next.displayedRunRef
  ) {
    return previous;
  }
  if (previous && isContinuationPromotion(previous, next)) {
    return { ...next, key: previous.key, generation: previous.generation };
  }
  // Every other change replaces the rows wholesale. The generation keeps the
  // key unique even when a run returns to a view it was keyed by earlier
  // (live run X, continued from history X, later reopened as history X).
  const generation = (previous?.generation ?? 0) + 1;
  const view = next.isViewingHistory
    ? `history:${next.displayedRunRef ?? ""}`
    : "live";
  return { ...next, key: `${view}#${generation}`, generation };
}

/**
 * The output pane's view key: row staging, entrance motion, bulk remeasure
 * and the measurement cache all reset when it changes.
 */
export function useOutputViewIdentity(input: OutputViewIdentityInput): string {
  const { isViewingHistory, displayedRunRef } = input;
  const [identity, setIdentity] = useState(() =>
    resolveOutputViewIdentity(null, { isViewingHistory, displayedRunRef })
  );
  const next = resolveOutputViewIdentity(identity, {
    isViewingHistory,
    displayedRunRef,
  });
  if (next !== identity) {
    // React's "adjust state while rendering" pattern: the new key is used by
    // this very render, never one commit late.
    setIdentity(next);
  }
  return next.key;
}
