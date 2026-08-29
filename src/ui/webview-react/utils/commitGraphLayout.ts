import type { WorkspaceCommitLogEntry } from "@root/types/HostedWorkspaceViewerTypes";

export const COMMIT_GRAPH_COLOR_COUNT = 5;

/** Reserved for the mainline (first-parent) chain; never assigned by rotation. */
export const TRUNK_COLOR_INDEX = 0;

export interface CommitGraphLane {
  /** Hash of the commit this lane is waiting to reach. */
  id: string;
  /** Index into the renderer's rotating graph-color palette. */
  colorIndex: number;
}

export interface CommitGraphRow {
  /** Column index where the commit's node is drawn. */
  laneIndex: number;
  /** Lane state entering this row. */
  inputLanes: CommitGraphLane[];
  /** Lane state leaving this row. */
  outputLanes: CommitGraphLane[];
}

type CommitGraphInput = Pick<WorkspaceCommitLogEntry, "hash" | "parentHashes">;

function cloneLanes(lanes: readonly CommitGraphLane[]): CommitGraphLane[] {
  return lanes.map((lane) => ({ ...lane }));
}

function rotateColor(colorIndex: number, offset: number): number {
  return (colorIndex + offset) % COMMIT_GRAPH_COLOR_COUNT;
}

/**
 * Computes the swimlane state for a commit history in display order.
 *
 * Ports VS Code's `toISCMHistoryItemViewModelArray` swimlane fold
 * (`scmHistory.ts`): a lane's first parent always inherits that lane's own
 * color and column, while every other parent (an additional merge parent, or
 * any parent introduced by a commit with no matching input lane) draws its
 * color from one shared, monotonically-rotating cursor. Deriving a "new"
 * color from the replaced lane's own color (e.g. `lane.colorIndex + 1`)
 * looks plausible but collides constantly in practice: most merges fork off
 * the mainline, whose color never changes, so every such fork would land on
 * the exact same "next" color instead of cycling through the palette.
 *
 * The input is intentionally only the commit identity and parent hashes. The
 * layout has no rendering or ref-decoration concerns and can therefore be
 * recomputed whenever the loaded history changes.
 */
export function computeCommitGraphLayout(
  commits: readonly CommitGraphInput[]
): CommitGraphRow[] {
  let colorIndex = -1;
  let previousOutputLanes: CommitGraphLane[] = [];

  return commits.map((commit) => {
    const inputLanes = cloneLanes(previousOutputLanes);
    const firstMatchingLaneIndex = inputLanes.findIndex(
      (lane) => lane.id === commit.hash
    );
    const laneIndex =
      firstMatchingLaneIndex === -1
        ? inputLanes.length
        : firstMatchingLaneIndex;

    const outputLanes: CommitGraphLane[] = [];
    let firstParentAdded = false;

    if (commit.parentHashes.length > 0) {
      for (const lane of inputLanes) {
        if (lane.id !== commit.hash) {
          outputLanes.push({ ...lane });
          continue;
        }

        if (!firstParentAdded) {
          outputLanes.push({
            id: commit.parentHashes[0],
            colorIndex: lane.colorIndex,
          });
          firstParentAdded = true;
        }

        // A merge can leave two lanes waiting for the same ancestor. Draw
        // that ancestor once and discard the later duplicate lane when it is
        // reached.
      }
    }

    // Any parent beyond the first — an additional merge parent, or every
    // parent when this commit had no matching input lane — draws a freshly
    // rotated color, appended after the lanes above.
    for (
      let parentIndex = firstParentAdded ? 1 : 0;
      parentIndex < commit.parentHashes.length;
      parentIndex++
    ) {
      colorIndex = rotateColor(colorIndex, 1);
      outputLanes.push({
        id: commit.parentHashes[parentIndex],
        colorIndex,
      });
    }

    const row: CommitGraphRow = {
      laneIndex,
      inputLanes,
      outputLanes,
    };
    previousOutputLanes = cloneLanes(outputLanes);
    return row;
  });
}
