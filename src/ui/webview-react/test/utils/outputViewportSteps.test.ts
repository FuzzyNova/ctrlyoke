import { describe, expect, it } from "vitest";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { getTargetKey } from "@utils/outputProjection";
import type {
  CliHeaderRow,
  OutputRenderRow,
  ParallelGroupHeaderRow,
  PlainResponseRow,
  PromptRow,
  ScriptCommandRow,
  StepAnchorRow,
} from "@utils/outputRows";
import {
  buildOutputStepSections,
  MIN_IN_VIEW_STEP_PX,
  resolveOutputViewportSteps,
} from "@utils/outputViewportSteps";

const ROW_HEIGHT = 100;
const STICKY_HEIGHT = 60;

function target(index: number) {
  return { kind: FINAL_STEP_PHASES.QUEUE, index } as const;
}

function anchor(key: string, step: number): StepAnchorRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.STEP_ANCHOR,
    target: target(step),
    estimateSize: 1,
  };
}

function header(key: string, step: number): CliHeaderRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.CLI_HEADER,
    target: target(step),
    estimateSize: 40,
    groupStart: true,
    output: { elapsed: 0, isStreaming: false },
    stepIndex: step,
    isFinalStep: false,
    stepLabel: `Step ${step + 1}`,
    attemptIndex: 0,
    runIndex: 0,
  };
}

function prompt(key: string, step: number): PromptRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.PROMPT,
    target: target(step),
    estimateSize: 40,
    text: "Do the thing",
  };
}

function scriptCommand(key: string, step: number): ScriptCommandRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.SCRIPT_COMMAND,
    target: target(step),
    estimateSize: 40,
    command: "npm test",
    workingDirectory: "packages/app",
  };
}

function response(key: string, step: number): PlainResponseRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
    target: target(step),
    estimateSize: 40,
    text: "Done.",
    rawTextOutput: false,
    animated: false,
  };
}

function groupHeader(
  key: string,
  startIndex: number,
  endIndex: number
): ParallelGroupHeaderRow {
  return {
    key,
    rowKind: OUTPUT_ROW_KINDS.PARALLEL_GROUP_HEADER,
    target: target(startIndex),
    estimateSize: 60,
    groupId: "group-a",
    startIndex,
    endIndex,
    members: [],
    running: 0,
    complete: 2,
    failed: 0,
    isAllVisible: true,
  };
}

/**
 *  0 anchor q0      7 anchor q1           11 group header (q2-q3)
 *  1 header q0      8 header q1           12 header q2
 *  2 prompt q0      9 script command q1   13 header q3
 *  3 response q0   10 response q1         14 response q2
 *  4 header q0 (retry)                    15 response q3
 *  5 prompt q0                            16 header q4
 *  6 response q0
 */
const ROWS: OutputRenderRow[] = [
  anchor("a0", 0),
  header("h0", 0),
  prompt("p0", 0),
  response("r0", 0),
  header("h0-retry", 0),
  prompt("p0-retry", 0),
  response("r0-retry", 0),
  anchor("a1", 1),
  header("h1", 1),
  scriptCommand("c1", 1),
  response("r1", 1),
  groupHeader("g", 2, 3),
  header("h2", 2),
  header("h3", 3),
  response("r2", 2),
  response("r3", 3),
  header("h4", 4),
];
const ROW_STARTS = ROWS.map((_, index) => index * ROW_HEIGHT);
const TOTAL_SIZE = ROWS.length * ROW_HEIGHT;
const MODEL = buildOutputStepSections(ROWS);

function resolveAt(viewportTop: number, viewportHeight = 300) {
  return resolveOutputViewportSteps({
    rows: ROWS,
    model: MODEL,
    rowStarts: ROW_STARTS,
    totalSize: TOTAL_SIZE,
    viewportTop,
    viewportBottom: viewportTop + viewportHeight,
    stickyHeightPx: STICKY_HEIGHT,
  });
}

describe("buildOutputStepSections", () => {
  it("splits rows into one section per step and one per parallel group", () => {
    expect(MODEL.sections).toEqual([
      { startRow: 0, endRow: 7, headerRows: [1, 4] },
      { startRow: 7, endRow: 11, headerRows: [8] },
      // Members' own headers stay in the stream; only the group header sticks.
      { startRow: 11, endRow: 16, headerRows: [11] },
      { startRow: 16, endRow: 17, headerRows: [16] },
    ]);
  });

  it("pairs each CLI header with the prompt or command row that opens its block", () => {
    expect(Object.fromEntries(MODEL.previewRowByHeaderRow)).toEqual({
      1: 2,
      4: 5,
      8: 9,
    });
  });
});

describe("resolveOutputViewportSteps", () => {
  it("sticks nothing while the step's header is still in view", () => {
    expect(resolveAt(0)).toEqual({
      inViewTargetKeys: [getTargetKey(target(0))],
      sticky: null,
    });
    // Exactly at the top edge counts as in view: the real header is there.
    expect(resolveAt(100).sticky).toBeNull();
  });

  it("sticks the header once it scrolls above the top of a single-step viewport", () => {
    expect(resolveAt(101).sticky).toEqual({
      headerRow: 1,
      previewRow: 2,
      offsetPx: 0,
    });
  });

  it("pushes the stuck header out as the step's next header reaches it", () => {
    // Retry header at 400; the sticky (60px) at 360 overlaps it by 20px.
    expect(resolveAt(360).sticky).toEqual({
      headerRow: 1,
      previewRow: 2,
      offsetPx: -20,
    });
    // Past it, the retry header is the one stuck.
    expect(resolveAt(401, 200).sticky).toEqual({
      headerRow: 4,
      previewRow: 5,
      offsetPx: 0,
    });
  });

  it("slides the header in from the top as the next step leaves the bottom", () => {
    // The group after step 2 starts at 1100. Its first row has just left the
    // bottom edge, so step 2's header is mounted but still fully above the
    // top...
    expect(resolveAt(900, 200).sticky).toEqual({
      headerRow: 8,
      previewRow: 9,
      offsetPx: -60,
    });
    // ...comes down as the boundary moves further below...
    expect(resolveAt(870, 200).sticky?.offsetPx).toBe(-30);
    // ...and is fully in place one header height later.
    expect(resolveAt(840, 200).sticky?.offsetPx).toBe(0);
    expect(resolveAt(810, 200).sticky?.offsetPx).toBe(0);
  });

  it("never slides the last step's header, which has no step below it", () => {
    expect(resolveAt(1601, 99).sticky).toEqual({
      headerRow: 16,
      offsetPx: 0,
    });
  });

  it("sticks nothing once a second step is in view", () => {
    const result = resolveAt(450);
    expect(result.sticky).toBeNull();
    expect(result.inViewTargetKeys).toEqual([
      getTargetKey(target(0)),
      getTargetKey(target(1)),
    ]);
  });

  it("ignores a sliver of the step above after navigating to a step", () => {
    // Step 2's anchor starts at 700; the landing is a pixel short, leaving
    // step 1's last row 1px on screen.
    expect(resolveAt(699).inViewTargetKeys).toEqual([getTargetKey(target(1))]);
    expect(resolveAt(700 - MIN_IN_VIEW_STEP_PX).inViewTargetKeys).toEqual([
      getTargetKey(target(0)),
      getTargetKey(target(1)),
    ]);
  });

  it("ignores a sliver of the next step at the bottom edge", () => {
    expect(resolveAt(401).inViewTargetKeys).toEqual([getTargetKey(target(0))]);
  });

  it("counts a short step that is entirely on screen", () => {
    const rows = [response("r0", 0), response("r1", 1), response("r2", 2)];
    const result = resolveOutputViewportSteps({
      rows,
      model: buildOutputStepSections(rows),
      rowStarts: [0, 100, 110],
      totalSize: 300,
      viewportTop: 50,
      viewportBottom: 200,
      stickyHeightPx: 0,
    });
    expect(result.inViewTargetKeys).toEqual([
      getTargetKey(target(0)),
      getTargetKey(target(1)),
      getTargetKey(target(2)),
    ]);
  });

  it("still reports the step filling a viewport shorter than the threshold", () => {
    expect(resolveAt(150, 10).inViewTargetKeys).toEqual([
      getTargetKey(target(0)),
    ]);
  });

  it("sticks a parallel group's header, never a member's, and reports every member in view", () => {
    const result = resolveAt(1301, 200);
    expect(result.sticky).toEqual({ headerRow: 11, offsetPx: 0 });
    expect(result.inViewTargetKeys).toEqual([
      getTargetKey(target(3)),
      getTargetKey(target(2)),
    ]);
  });

  it("reports nothing without rows or a usable viewport", () => {
    expect(
      resolveOutputViewportSteps({
        rows: [],
        model: buildOutputStepSections([]),
        rowStarts: [],
        totalSize: 0,
        viewportTop: 0,
        viewportBottom: 500,
        stickyHeightPx: 0,
      })
    ).toEqual({ inViewTargetKeys: [], sticky: null });
    expect(resolveAt(200, 0)).toEqual({ inViewTargetKeys: [], sticky: null });
  });
});
