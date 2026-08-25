import type { WorkspaceCommitLogEntry } from "@root/types/HostedWorkspaceViewerTypes";

const COMMIT_GRAPH_COLOR_COUNT = 5;

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

function lanesForParents(
  lane: CommitGraphLane,
  parentHashes: readonly string[]
): CommitGraphLane[] {
  return parentHashes.map((id, parentIndex) => ({
    id,
    colorIndex: rotateColor(lane.colorIndex, parentIndex),
  }));
}

/**
 * Computes the swimlane state for a commit history in display order.
 *
 * The input is intentionally only the commit identity and parent hashes. The
 * layout has no rendering or ref-decoration concerns and can therefore be
 * recomputed whenever the loaded history changes.
 */
export function computeCommitGraphLayout(
  commits: readonly CommitGraphInput[]
): CommitGraphRow[] {
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
    let replacedMatchingLane = false;

    for (const lane of inputLanes) {
      if (lane.id !== commit.hash) {
        outputLanes.push({ ...lane });
        continue;
      }

      // A merge can leave two lanes waiting for the same ancestor. Draw that
      // ancestor once and discard the later duplicate lane when it is reached.
      if (replacedMatchingLane) {
        continue;
      }

      outputLanes.push(...lanesForParents(lane, commit.parentHashes));
      replacedMatchingLane = true;
    }

    if (firstMatchingLaneIndex === -1) {
      // A commit can appear before its child/branch has established a lane in
      // a date-ordered or truncated history. Start it in a new column and let
      // its parents continue from there.
      outputLanes.push(
        ...lanesForParents(
          { id: commit.hash, colorIndex: 0 },
          commit.parentHashes
        )
      );
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
