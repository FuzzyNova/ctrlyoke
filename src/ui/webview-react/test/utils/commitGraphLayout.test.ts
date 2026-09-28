import { describe, expect, it } from "vitest";
import { computeCommitGraphLayout } from "@utils/commitGraphLayout";

const commit = (hash: string, ...parentHashes: string[]) => ({
  hash,
  parentHashes,
});

const laneIds = (lanes: readonly { id: string }[]) =>
  lanes.map((lane) => lane.id);

describe("computeCommitGraphLayout", () => {
  it("keeps a linear history in one lane", () => {
    const rows = computeCommitGraphLayout([
      commit("A", "B"),
      commit("B", "C"),
      commit("C"),
    ]);

    expect(rows.map((row) => row.laneIndex)).toEqual([0, 0, 0]);
    expect(rows.map((row) => laneIds(row.inputLanes))).toEqual([
      [],
      ["B"],
      ["C"],
    ]);
    expect(rows.map((row) => laneIds(row.outputLanes))).toEqual([
      ["B"],
      ["C"],
      [],
    ]);
    expect(rows[0].outputLanes[0]).not.toBe(rows[1].inputLanes[0]);
  });

  it("forks a merge into colored parent lanes and rejoins them", () => {
    const rows = computeCommitGraphLayout([
      commit("M", "A", "B"),
      commit("A", "C"),
      commit("B", "C"),
      commit("C"),
    ]);

    expect(rows[0].laneIndex).toBe(0);
    expect(rows[0].outputLanes).toEqual([
      { id: "A", colorIndex: 0 },
      { id: "B", colorIndex: 1 },
    ]);
    expect(rows[1].laneIndex).toBe(0);
    expect(rows[1].outputLanes).toEqual([
      { id: "C", colorIndex: 0 },
      { id: "B", colorIndex: 1 },
    ]);
    expect(rows[2].laneIndex).toBe(1);
    expect(rows[2].inputLanes).toEqual([
      { id: "C", colorIndex: 0 },
      { id: "B", colorIndex: 1 },
    ]);
    expect(rows[2].outputLanes).toEqual([
      { id: "C", colorIndex: 0 },
      { id: "C", colorIndex: 1 },
    ]);
    expect(rows[3].laneIndex).toBe(0);
    expect(rows[3].outputLanes).toEqual([]);
  });

  it("keeps criss-cross lane continuity while collapsing converged lanes", () => {
    const rows = computeCommitGraphLayout([
      commit("M2", "L2", "R2"),
      commit("L2", "M1"),
      commit("R2", "R1"),
      commit("M1", "L1", "R1"),
      commit("R1", "R"),
      commit("L1", "R"),
      commit("R"),
    ]);

    expect(rows.map((row) => row.laneIndex)).toEqual([0, 0, 1, 0, 1, 0, 0]);
    expect(rows[2].outputLanes).toEqual([
      { id: "M1", colorIndex: 0 },
      { id: "R1", colorIndex: 1 },
    ]);
    expect(rows[3].outputLanes).toEqual([
      { id: "L1", colorIndex: 0 },
      { id: "R1", colorIndex: 1 },
      { id: "R1", colorIndex: 2 },
    ]);
    expect(rows[4].outputLanes).toEqual([
      { id: "L1", colorIndex: 0 },
      { id: "R", colorIndex: 1 },
    ]);
    expect(rows[6].inputLanes).toEqual([
      { id: "R", colorIndex: 0 },
      { id: "R", colorIndex: 1 },
    ]);
    expect(rows[6].outputLanes).toEqual([]);
  });

  it("assigns successive rotating colors to an octopus merge", () => {
    const rows = computeCommitGraphLayout([
      commit("O", "A", "B", "C", "D"),
      commit("A", "R"),
      commit("B", "R"),
      commit("C", "R"),
      commit("D", "R"),
      commit("R"),
    ]);

    expect(rows[0].outputLanes).toEqual([
      { id: "A", colorIndex: 0 },
      { id: "B", colorIndex: 1 },
      { id: "C", colorIndex: 2 },
      { id: "D", colorIndex: 3 },
    ]);
    expect(rows.slice(1, 5).map((row) => row.laneIndex)).toEqual([0, 1, 2, 3]);
    expect(rows[4].outputLanes).toEqual([
      { id: "R", colorIndex: 0 },
      { id: "R", colorIndex: 1 },
      { id: "R", colorIndex: 2 },
      { id: "R", colorIndex: 3 },
    ]);
    expect(rows[5].laneIndex).toBe(0);
    expect(rows[5].outputLanes).toEqual([]);
  });

  it("keeps rotating side branches out of the trunk color", () => {
    const commits = [];
    for (let index = 1; index <= 5; index++) {
      commits.push(commit(`M${index}`, `M${index + 1}`, `S${index}`));
      commits.push(commit(`S${index}`, `M${index + 1}`));
    }
    commits.push(commit("M6"));

    const rows = computeCommitGraphLayout(commits);
    const sideBranchColors = rows
      .filter((_, index) => index % 2 === 0 && index < 10)
      .map((row) => row.outputLanes.find((lane) => lane.id.startsWith("S")))
      .map((lane) => lane?.colorIndex);

    expect(sideBranchColors).toEqual([1, 2, 3, 4, 5]);
    expect(sideBranchColors).not.toContain(0);
  });

  it("lets an unloaded parent continue off the bottom of the window", () => {
    const rows = computeCommitGraphLayout([commit("tip", "unloaded-parent")]);

    expect(rows[0].laneIndex).toBe(0);
    expect(rows[0].inputLanes).toEqual([]);
    expect(rows[0].outputLanes).toEqual([
      { id: "unloaded-parent", colorIndex: 0 },
    ]);
  });
});
