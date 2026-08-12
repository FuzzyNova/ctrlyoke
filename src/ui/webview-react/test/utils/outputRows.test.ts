import { describe, expect, it } from "vitest";
import type { WorkflowStep } from "@store/workflowStore";
import { buildOutputRows, estimateOutputRowHeight } from "@utils/outputRows";
import type { OutputMessage } from "@utils/outputProjection";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";
import {
  OUTPUT_ROW_GROUP_END_PADDING,
  OUTPUT_ROW_GROUP_START_PADDING,
  TOOL_CALL_BLOCK_VERTICAL_CHROME,
  toolCallLineHeight,
  toolResultLineHeight,
} from "@utils/outputLineMetrics";
import {
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  SCRIPT_OUTPUT_LINES_PER_ROW,
} from "@utils/outputTruncation";
import {
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
  SCRIPT_OUTPUT_SOURCES,
  getStreamingChunkKey,
} from "@/types/messages";

describe("outputRows", () => {
  const steps = [{ name: "Analyze code" } as WorkflowStep];

  it("collapses retry attempts into an explicitly labelled aggregate", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const allMessages: OutputMessage[] = [0, 1].map((attemptIndex) => ({
      type: "cli" as const,
      target,
      timestamp: 1000 + attemptIndex,
      attemptIndex,
      runIndex: 0,
      data: {
        prompt: "Inspect code",
        response: "done",
        elapsed: 1,
        isStreaming: false,
        tokens: { prompt: 100, completion: 100, total: 200 },
      },
    }));

    const common = {
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
    };

    const collapsed = buildOutputRows({
      ...common,
      collapsedAttemptGroupKeys: new Set(["queue:0:run0"]),
    });
    const summary = collapsed.rows.find(
      (row) => row.rowKind === "attempt-group-summary"
    );
    expect(summary).toMatchObject({
      attemptCount: 2,
      total: 400,
      coverage: "complete",
    });

    const expanded = buildOutputRows(common);
    expect(expanded.rows.filter((row) => row.rowKind === "stats")).toHaveLength(
      2
    );
  });

  it("threads the collapsed tool output line count into Bash and generic tool rows", () => {
    const output = Array.from(
      { length: 8 },
      (_, index) => `line ${index + 1}`
    ).join("\n");
    const result = buildOutputRows({
      allMessages: [
        {
          type: "cli",
          target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
          timestamp: 1000,
          attemptIndex: 0,
          runIndex: 0,
          data: {
            prompt: "Inspect output",
            response: "",
            elapsed: 0,
            isStreaming: false,
            structured: {
              events: [
                {
                  type: CLI_EVENT_TYPES.BASH_COMMAND,
                  data: {
                    command: "cat output.txt",
                    output,
                    status: OPERATION_STATUS.COMPLETED,
                  },
                },
                {
                  type: CLI_EVENT_TYPES.TOOL_CALL,
                  data: {
                    name: "read_file",
                    parameters: {},
                    result: { success: true, output },
                  },
                },
              ],
              metadata: {},
            },
          },
        },
      ],
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      collapsedToolOutputLineCount: 4,
      outputContentWidth: 320,
      outputFontSize: 13,
    });

    const bashRow = result.rows.find(
      (row) =>
        row.rowKind === "structured-event" &&
        row.event.type === CLI_EVENT_TYPES.BASH_COMMAND
    );
    const toolCallRow = result.rows.find(
      (row) =>
        row.rowKind === "structured-event" &&
        row.event.type === CLI_EVENT_TYPES.TOOL_CALL
    );

    if (
      !bashRow ||
      bashRow.rowKind !== "structured-event" ||
      !toolCallRow ||
      toolCallRow.rowKind !== "structured-event"
    ) {
      throw new Error("Expected Bash and generic tool output rows");
    }

    expect(bashRow.collapsedToolOutputLineCount).toBe(4);
    expect(bashRow.collapsedToolOutputMaxCharacters).toBeLessThan(1200);
    expect(toolCallRow.toolCall?.renderPlan.output.visibleLineCount).toBe(4);
    expect(toolCallRow.toolCall?.renderPlan.maxResultChars).toBeLessThan(1200);
  });

  it("adds a verdict between the response and stats rows", () => {
    const result = buildOutputRows({
      allMessages: [
        {
          type: "cli",
          target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
          timestamp: 1000,
          attemptIndex: 0,
          runIndex: 0,
          data: {
            prompt: "Run the condition",
            cliCommand: "npm test",
            response: "PASS",
            elapsed: 1.2,
            isStreaming: false,
            source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
            scriptVerdict: {
              compareSource: "stdout",
              expected: "PASS",
              actual: "PASS",
              actualSource: "stdout",
              exitCode: 0,
              outcome: "passed",
              matchRule: "exact",
              action: "continue",
              durationMs: 1200,
            },
          },
        },
      ],
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
    });

    expect(result.rows.map((row) => row.rowKind)).toEqual([
      "step-anchor",
      "cli-header",
      "prompt",
      "cli-command",
      "script-output",
      "script-verdict",
      "stats",
    ]);
    const verdictRow = result.rows.find(
      (row) => row.rowKind === "script-verdict"
    );
    expect(verdictRow?.estimateSize).toBeGreaterThan(0);
    expect(verdictRow).toMatchObject({ expanded: false });
    if (!verdictRow || verdictRow.rowKind !== "script-verdict") {
      throw new Error("Expected a script verdict row");
    }
    expect(estimateOutputRowHeight(verdictRow, 13, 240)).toBeGreaterThan(
      estimateOutputRowHeight(verdictRow, 13, 1200)
    );
  });

  it("keeps streaming chunks isolated by execution phase", () => {
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        phase: EXECUTION_PHASES.PRE_CONDITION,
        data: {
          prompt: "pre",
          cliCommand: "npm run pre",
          response: "",
          elapsed: 0,
          isStreaming: true,
          source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
        },
      },
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1001,
        phase: EXECUTION_PHASES.END_CONDITION,
        data: {
          prompt: "end",
          cliCommand: "npm run end",
          response: "",
          elapsed: 0,
          isStreaming: true,
          source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
        },
      },
    ];

    const result = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {
        [getStreamingChunkKey(0, EXECUTION_PHASES.PRE_CONDITION)]: "pre output",
        [getStreamingChunkKey(0, EXECUTION_PHASES.END_CONDITION)]: "end output",
      },
      finalStepStreamingChunks: {},
      isExecutionActive: true,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
    });

    expect(
      result.rows
        .filter((row) => row.rowKind === "script-output")
        .map((row) => row.text)
    ).toEqual(["pre output", "end output"]);
  });

  it("projects queue output into flat rows in render order", () => {
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Analyze code",
          cliCommand: "copilot -p",
          response: "Done.",
          elapsed: 1.2,
          isStreaming: false,
          tokens: { prompt: 10, completion: 5 },
        },
      },
    ];

    const result = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: true,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
    });

    expect(result.rows.map((row) => row.rowKind)).toEqual([
      "step-anchor",
      "cli-header",
      "prompt",
      "cli-command",
      "plain-response",
      "stats",
    ]);
    expect(result.firstRowIndexByTarget.get("queue:0")).toBe(0);
    expect(result.lastCliIndexPerStep.get("queue:0")).toBe(0);
  });

  it("marks injected prompt rows so they render without a workspace command prefix", () => {
    const result = buildOutputRows({
      allMessages: [
        {
          type: "cli",
          target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
          timestamp: 1000,
          attemptIndex: 0,
          runIndex: 0,
          data: {
            prompt: "Use inject mode",
            cliCommand: "Actual injected prompt text",
            cliCommandWasInjected: true,
            response: "",
            elapsed: 0,
            isStreaming: false,
          },
        },
      ],
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
    });

    expect(
      result.rows.find((row) => row.rowKind === "cli-command")
    ).toMatchObject({
      rowKind: "cli-command",
      command: "Actual injected prompt text",
      wasInjected: true,
    });
  });

  it("keeps diff row keys stable when unrelated streaming chunks change", () => {
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Edit file",
          response: "",
          elapsed: 0.5,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/example.ts",
                  status: OPERATION_STATUS.COMPLETED,
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ["-const a = 1;", "+const a = 2;"],
                    },
                  ],
                },
              },
            ],
            metadata: {},
          },
        },
      },
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
        timestamp: 1001,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Stream text",
          response: "",
          elapsed: 0,
          isStreaming: true,
        },
      },
    ];

    const baseInput = {
      allMessages,
      steps: [{ name: "Edit file" }, { name: "Stream text" }] as WorkflowStep[],
      finalStep: null,
      finalStepStreamingChunks: {},
      isExecutionActive: true,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map<string, boolean>(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
    };

    const first = buildOutputRows({
      ...baseInput,
      streamingChunks: { 1: "alpha" },
    });
    const second = buildOutputRows({
      ...baseInput,
      streamingChunks: { 1: "beta" },
    });

    const firstDiffRow = first.rows.find(
      (row) => row.rowKind === "structured-event" && row.diff
    );
    const secondDiffRow = second.rows.find(
      (row) => row.rowKind === "structured-event" && row.diff
    );

    expect(firstDiffRow?.key).toBe(secondDiffRow?.key);
    expect(firstDiffRow?.rowKind).toBe("structured-event");
    expect(secondDiffRow?.rowKind).toBe("structured-event");
  });

  it("uses split-view diff runs when projecting desktop minimap metadata", () => {
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Edit file",
          response: "",
          elapsed: 0.5,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/example.ts",
                  status: OPERATION_STATUS.COMPLETED,
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ["-const a = 1;", "+const a = 2;"],
                    },
                  ],
                },
              },
            ],
            metadata: {},
          },
        },
      },
    ];

    const result = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: true,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      diffViewType: "split",
    });

    const diffRow = result.rows.find(
      (row) => row.rowKind === "structured-event" && row.diff
    );

    if (!diffRow || diffRow.rowKind !== "structured-event") {
      throw new Error("Expected a structured diff row");
    }

    expect(diffRow.diff?.runs).toEqual([
      { count: 1, addedLines: 1, removedLines: 1 },
    ]);
    expect(diffRow.diff?.renderPlan.renderedRows).toBe(1);
    expect(diffRow.diff?.renderPlan.viewType).toBe("split");
    expect(estimateOutputRowHeight(diffRow)).toBeGreaterThan(80);
  });

  it("does not create minimap diff metadata for hidden duplicate edit previews", () => {
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Edit file",
          response: "",
          elapsed: 0.5,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/example.ts",
                  status: OPERATION_STATUS.INITIATED,
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ["-const a = 1;", "+const a = 2;"],
                    },
                  ],
                },
              },
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/example.ts",
                  status: OPERATION_STATUS.COMPLETED,
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ["-const a = 1;", "+const a = 2;"],
                    },
                  ],
                },
              },
            ],
            metadata: {},
          },
        },
      },
    ];

    const result = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: true,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
    });

    const diffRows = result.rows.filter(
      (row) => row.rowKind === "structured-event" && row.diff
    );

    expect(diffRows).toHaveLength(1);
  });

  it("threads diff gap and tool call expansion state into structured rows", () => {
    const beforeContent = Array.from(
      { length: 42 },
      (_, index) => `line ${index + 1}`
    ).join("\n");
    const diffKey = "fp-diff-q-0-r0-a0-e0";
    const toolRowKey = "queue:1:run0:attempt0:event:0";
    const expandedGaps = new Map<number, number>([[1, 27]]);
    const steps = [
      { name: "Expand diff" },
      { name: "Call tool" },
    ] as WorkflowStep[];
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Expand diff",
          response: "",
          elapsed: 0.5,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/example.ts",
                  status: OPERATION_STATUS.COMPLETED,
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ["-line 1", "+updated start"],
                    },
                    {
                      oldStart: 42,
                      oldLines: 1,
                      newStart: 42,
                      newLines: 1,
                      lines: ["-line 42", "+updated end"],
                    },
                  ],
                },
              },
            ],
            metadata: {},
          },
        },
      },
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
        timestamp: 1001,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Call tool",
          response: "",
          elapsed: 0.5,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.TOOL_CALL,
                data: {
                  name: "write_memory",
                  parameters: {
                    subject: "output-layout",
                    detail: "lift expansion state",
                  },
                  result: {
                    success: true,
                    output: Array.from(
                      { length: 12 },
                      (_, index) => `line ${index + 1}`
                    ).join("\n"),
                  },
                },
              },
            ],
            metadata: {},
          },
        },
      },
    ];

    const result = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {
        0: {
          capturedAt: Date.now(),
          strategy: "git",
          git: {
            headCommit: "0123456789abcdef0123456789abcdef01234567",
            branch: "main",
          },
          changedFiles: [
            {
              path: "src/example.ts",
              changeType: "modified",
              beforeContent,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-line 1", "+updated start"],
                },
                {
                  oldStart: 42,
                  oldLines: 1,
                  newStart: 42,
                  newLines: 1,
                  lines: ["-line 42", "+updated end"],
                },
              ],
            },
          ],
        },
      },
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map([[diffKey, false]]),
      diffExpansionState: new Map([[diffKey, expandedGaps]]),
      toolCallExpansionState: new Map([
        [
          toolRowKey,
          {
            paramsExpanded: true,
            outputExpanded: true,
            errorExpanded: false,
          },
        ],
      ]),
      defaultDiffCollapsed: false,
      diffViewType: "unified",
    });
    const baseResult = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {
        0: {
          capturedAt: Date.now(),
          strategy: "git",
          git: {
            headCommit: "0123456789abcdef0123456789abcdef01234567",
            branch: "main",
          },
          changedFiles: [
            {
              path: "src/example.ts",
              changeType: "modified",
              beforeContent,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-line 1", "+updated start"],
                },
                {
                  oldStart: 42,
                  oldLines: 1,
                  newStart: 42,
                  newLines: 1,
                  lines: ["-line 42", "+updated end"],
                },
              ],
            },
          ],
        },
      },
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map([[diffKey, false]]),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map([
        [
          toolRowKey,
          {
            paramsExpanded: false,
            outputExpanded: false,
            errorExpanded: false,
          },
        ],
      ]),
      defaultDiffCollapsed: false,
      diffViewType: "unified",
    });

    const diffRow = result.rows.find(
      (row) => row.rowKind === "structured-event" && row.diff?.key === diffKey
    );
    const toolRow = result.rows.find(
      (row) => row.rowKind === "structured-event" && row.key === toolRowKey
    );
    const baseToolRow = baseResult.rows.find(
      (row) => row.rowKind === "structured-event" && row.key === toolRowKey
    );
    const baseDiffRow = baseResult.rows.find(
      (row) => row.rowKind === "structured-event" && row.diff?.key === diffKey
    );

    if (!diffRow || diffRow.rowKind !== "structured-event" || !diffRow.diff) {
      throw new Error("Expected diff row");
    }
    if (
      !toolRow ||
      toolRow.rowKind !== "structured-event" ||
      !toolRow.toolCall
    ) {
      throw new Error("Expected tool-call row");
    }
    if (
      !baseToolRow ||
      baseToolRow.rowKind !== "structured-event" ||
      !baseToolRow.toolCall
    ) {
      throw new Error("Expected base tool-call row");
    }
    if (!baseDiffRow || baseDiffRow.rowKind !== "structured-event") {
      throw new Error("Expected base diff row");
    }

    expect(diffRow.diff.expandedGaps).toBe(expandedGaps);
    expect(diffRow.diff.renderPlan.gapExpansion).toEqual({
      model: "exact",
      requestedGaps: 1,
      appliedGaps: 1,
    });
    expect(diffRow.diff.renderPlan.totalHeight).toBe(
      estimateOutputRowHeight(diffRow)
    );
    expect(estimateOutputRowHeight(diffRow)).toBeGreaterThan(
      estimateOutputRowHeight(baseDiffRow)
    );
    expect(baseDiffRow.diff?.renderPlan.gapExpansion).toEqual({
      model: "none",
      requestedGaps: 0,
      appliedGaps: 0,
    });
    expect(toolRow.toolCall.expansion).toEqual({
      paramsExpanded: true,
      outputExpanded: true,
      errorExpanded: false,
    });
    expect(toolRow.toolCall.renderPlan.paramsLineCount).toBe(2);
    expect(toolRow.toolCall.renderPlan.outputLineCount).toBe(12);
    expect(toolRow.toolCall.renderPlan.params.visibleLineCount).toBe(2);
    expect(toolRow.toolCall.renderPlan.output.visibleLineCount).toBe(12);
    // Expanded output shows every line, so the preview reports it as untruncated.
    expect(toolRow.toolCall.renderPlan.isOutputTruncated).toBe(false);
    expect(toolRow.toolCall.renderPlan.totalHeight).toBe(
      estimateOutputRowHeight(toolRow)
    );
    expect(baseToolRow.toolCall.renderPlan.params.visibleLineCount).toBe(0);
    // Collapsed to DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT of the 12 lines.
    expect(baseToolRow.toolCall.renderPlan.output.visibleLineCount).toBe(
      DEFAULT_COLLAPSED_OUTPUT_MAX_LINES
    );
    expect(baseToolRow.toolCall.renderPlan.output.hiddenLineCount).toBe(
      12 - DEFAULT_COLLAPSED_OUTPUT_MAX_LINES
    );
    expect(baseToolRow.toolCall.renderPlan.totalHeight).toBe(
      estimateOutputRowHeight(baseToolRow)
    );
    expect(estimateOutputRowHeight(toolRow)).toBeGreaterThan(
      estimateOutputRowHeight(baseToolRow)
    );
  });

  it("scales plain-response estimates with available output width", () => {
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Explain result",
          response:
            "This is a long response line intended to wrap multiple times in a narrow panel width and much less in a wide panel width.",
          elapsed: 0.5,
          isStreaming: false,
        },
      },
    ];

    const narrow = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      outputContentWidth: 320,
    });
    const wide = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      outputContentWidth: 960,
    });

    const narrowResponse = narrow.rows.find(
      (row) => row.rowKind === "plain-response"
    );
    const wideResponse = wide.rows.find(
      (row) => row.rowKind === "plain-response"
    );

    if (!narrowResponse || !wideResponse) {
      throw new Error("Expected plain response rows");
    }

    expect(narrowResponse.estimateSize).toBeGreaterThan(
      wideResponse.estimateSize
    );
  });

  it("estimates a multi-column markdown table far taller than plain prose", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const tableText = [
      "| ID | Name | Category | Status | Owner | Priority | Notes | Start Date | End Date | Details |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...Array.from(
        { length: 10 },
        (_, i) =>
          `| ${i + 1} | Alpha | Planning | In Progress | Maya | High | Building the first pass of the markdown renderer with theme-aware output | 2026-06-01 | 2026-06-05 | Define acceptance criteria, identify integration points, and document any cross-layer contract changes before implementation begins. |`
      ),
    ].join("\n");

    const tableRow = {
      key: "table",
      rowKind: "plain-response",
      target,
      text: tableText,
      rawTextOutput: false,
      animated: false,
      estimateSize: 0,
    } as const;

    // Same character volume rendered as plain prose (no table layout).
    const proseRow = {
      ...tableRow,
      key: "prose",
      text: tableText.replace(/\|/g, " "),
    } as const;

    const tableHeight = estimateOutputRowHeight(tableRow, 13, 600);
    const proseHeight = estimateOutputRowHeight(proseRow, 13, 600);

    // The column-aware estimate must account for narrow columns wrapping each
    // cell over many lines — historically this regressed to a ~3× underestimate
    // (≈1100px) when streamdown's table renderer replaced the custom one.
    expect(tableHeight).toBeGreaterThan(2500);
    expect(tableHeight).toBeGreaterThan(proseHeight * 2);
  });

  it("estimates a small fitting table close to one line per row", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const smallTable = [
      "| Key | Value |",
      "|---|---|",
      "| a | 1 |",
      "| b | 2 |",
      "| c | 3 |",
    ].join("\n");

    const row = {
      key: "small-table",
      rowKind: "plain-response",
      target,
      text: smallTable,
      rawTextOutput: false,
      animated: false,
      estimateSize: 0,
    } as const;

    const height = estimateOutputRowHeight(row, 13, 760);
    // 4 single-line rows + streamdown wrapper chrome — well under a wrapped
    // many-column table, but above the bare wrapper chrome.
    expect(height).toBeGreaterThan(120);
    expect(height).toBeLessThan(400);
  });

  it("scales bash structured-event estimates with content length and width", () => {
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Run command",
          response: "",
          elapsed: 0.5,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.BASH_COMMAND,
                data: {
                  command: "npm test -- --runInBand --reporter verbose",
                  status: OPERATION_STATUS.COMPLETED,
                  output: Array.from(
                    { length: 20 },
                    (_, index) => `log line ${index + 1}`
                  ).join("\n"),
                },
              },
            ],
            metadata: {},
          },
        },
      },
    ];

    const result = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      outputContentWidth: 360,
    });

    const bashRow = result.rows.find(
      (row) =>
        row.rowKind === "structured-event" &&
        row.event.type === CLI_EVENT_TYPES.BASH_COMMAND
    );

    if (!bashRow || bashRow.rowKind !== "structured-event") {
      throw new Error("Expected bash structured-event row");
    }

    // A ● block's height is exactly my-2 plus whole header and ⎿ result lines —
    // profiler measurements land on this grid with zero residual. In particular
    // there is no extra line for the "[show N more lines]" toggle: it is an
    // inline <button> on the last visible line, not a block of its own.
    expect(bashRow.estimateSize).toBe(
      TOOL_CALL_BLOCK_VERTICAL_CHROME +
        toolCallLineHeight(13) +
        DEFAULT_COLLAPSED_OUTPUT_MAX_LINES * toolResultLineHeight(13)
    );
  });

  it("uses collapsed character-limited bash previews in row estimates", () => {
    const rowKey = "queue:0:run0:attempt0:event:0";
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Run command",
          response: "",
          elapsed: 0.5,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.BASH_COMMAND,
                data: {
                  command: "node script.js",
                  status: OPERATION_STATUS.COMPLETED,
                  output: "x".repeat(5000),
                },
              },
            ],
            metadata: {},
          },
        },
      },
    ];
    const baseInput = {
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      outputContentWidth: 360,
    };

    const collapsed = buildOutputRows(baseInput);
    const expanded = buildOutputRows({
      ...baseInput,
      bashExpansionState: new Map([
        [
          rowKey,
          {
            commandExpanded: false,
            outputExpanded: true,
            errorExpanded: false,
          },
        ],
      ]),
    });

    const collapsedRow = collapsed.rows.find((row) => row.key === rowKey);
    const expandedRow = expanded.rows.find((row) => row.key === rowKey);

    if (!collapsedRow || !expandedRow) {
      throw new Error("Expected bash rows");
    }

    expect(collapsedRow.estimateSize).toBeLessThan(expandedRow.estimateSize);
  });

  it("estimates bash rows from sanitized terminal output", () => {
    const cleanLine = "ok";
    const noisyLine = `\u001b[32m${cleanLine}\u001b[0m\u0007`;
    const buildWithOutput = (output: string) =>
      buildOutputRows({
        allMessages: [
          {
            type: "cli",
            target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
            timestamp: 1000,
            attemptIndex: 0,
            runIndex: 0,
            data: {
              prompt: "Run command",
              response: "",
              elapsed: 0.5,
              isStreaming: false,
              structured: {
                events: [
                  {
                    type: CLI_EVENT_TYPES.BASH_COMMAND,
                    data: {
                      command: "printf",
                      status: OPERATION_STATUS.COMPLETED,
                      output,
                    },
                  },
                ],
                metadata: {},
              },
            },
          },
        ],
        steps,
        finalStep: null,
        streamingChunks: {},
        finalStepStreamingChunks: {},
        isExecutionActive: false,
        allowUndoActions: false,
        isViewingHistory: false,
        historyOutputs: null,
        workspaceSnapshots: {},
        finalStepWorkspaceSnapshots: {},
        undoRecords: {},
        diffCollapseState: new Map(),
        diffExpansionState: new Map(),
        toolCallExpansionState: new Map(),
        defaultDiffCollapsed: false,
        outputContentWidth: 360,
      });

    const cleanRow = buildWithOutput(cleanLine).rows.find(
      (row) =>
        row.rowKind === "structured-event" &&
        row.event.type === CLI_EVENT_TYPES.BASH_COMMAND
    );
    const noisyRow = buildWithOutput(noisyLine).rows.find(
      (row) =>
        row.rowKind === "structured-event" &&
        row.event.type === CLI_EVENT_TYPES.BASH_COMMAND
    );

    if (!cleanRow || !noisyRow) {
      throw new Error("Expected bash rows");
    }

    expect(noisyRow.estimateSize).toBe(cleanRow.estimateSize);
  });

  it("scales file-operation structured-event estimates with wrapped path width", () => {
    const longPath = `src/${"deeply-nested-segment/".repeat(10)}example-file-with-a-very-long-name.ts`;
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Read file",
          response: "",
          elapsed: 0.5,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.FILE_READ,
                data: {
                  path: longPath,
                  status: OPERATION_STATUS.COMPLETED,
                },
              },
            ],
            metadata: {},
          },
        },
      },
    ];

    const narrow = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      outputContentWidth: 320,
    });
    const wide = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      outputContentWidth: 960,
    });

    const narrowRow = narrow.rows.find(
      (row) =>
        row.rowKind === "structured-event" &&
        row.event.type === CLI_EVENT_TYPES.FILE_READ
    );
    const wideRow = wide.rows.find(
      (row) =>
        row.rowKind === "structured-event" &&
        row.event.type === CLI_EVENT_TYPES.FILE_READ
    );

    if (
      !narrowRow ||
      narrowRow.rowKind !== "structured-event" ||
      !wideRow ||
      wideRow.rowKind !== "structured-event"
    ) {
      throw new Error("Expected file-read structured-event rows");
    }

    expect(narrowRow.estimateSize).toBeGreaterThan(wideRow.estimateSize);
  });

  it("scales diff structured-event estimates with wrapped line length and width", () => {
    const longRemovedLine = `-${"legacyWrappedSegment ".repeat(40)}`;
    const longAddedLine = `+${"replacementWrappedSegment ".repeat(38)}`;
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Apply wide diff",
          response: "",
          elapsed: 0.5,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/example.ts",
                  status: OPERATION_STATUS.COMPLETED,
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 2,
                      newStart: 1,
                      newLines: 2,
                      lines: [longRemovedLine, longAddedLine],
                    },
                  ],
                },
              },
            ],
            metadata: {},
          },
        },
      },
    ];

    const narrow = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      diffViewType: "unified",
      outputContentWidth: 320,
    });
    const wide = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      diffViewType: "unified",
      outputContentWidth: 960,
    });

    const narrowDiff = narrow.rows.find(
      (row) => row.rowKind === "structured-event" && row.diff
    );
    const wideDiff = wide.rows.find(
      (row) => row.rowKind === "structured-event" && row.diff
    );

    if (
      !narrowDiff ||
      narrowDiff.rowKind !== "structured-event" ||
      !wideDiff ||
      wideDiff.rowKind !== "structured-event"
    ) {
      throw new Error("Expected diff structured-event rows");
    }

    expect(narrowDiff.estimateSize).toBeGreaterThan(wideDiff.estimateSize);
    expect(narrowDiff.diff?.renderPlan.totalHeight).toBe(
      narrowDiff.estimateSize
    );
    expect(wideDiff.diff?.renderPlan.totalHeight).toBe(wideDiff.estimateSize);
    expect(narrowDiff.diff?.renderPlan.renderedRows).toBe(2);
  });

  it("grows a collapsed diff row by one header line when its path wraps", () => {
    const buildDiffRow = (path: string) => {
      const rows = buildOutputRows({
        allMessages: [
          {
            type: "cli",
            target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
            timestamp: 1000,
            attemptIndex: 0,
            runIndex: 0,
            data: {
              prompt: "Apply edit",
              response: "",
              elapsed: 0.5,
              isStreaming: false,
              structured: {
                events: [
                  {
                    type: CLI_EVENT_TYPES.FILE_EDIT,
                    data: {
                      path,
                      status: OPERATION_STATUS.COMPLETED,
                      structuredPatch: [
                        {
                          oldStart: 1,
                          oldLines: 1,
                          newStart: 1,
                          newLines: 1,
                          lines: ["-before", "+after"],
                        },
                      ],
                    },
                  },
                ],
                metadata: {},
              },
            },
          },
        ],
        steps,
        finalStep: null,
        streamingChunks: {},
        finalStepStreamingChunks: {},
        isExecutionActive: false,
        allowUndoActions: false,
        isViewingHistory: false,
        historyOutputs: null,
        workspaceSnapshots: {},
        finalStepWorkspaceSnapshots: {},
        undoRecords: {},
        diffCollapseState: new Map(),
        diffExpansionState: new Map(),
        toolCallExpansionState: new Map(),
        defaultDiffCollapsed: true,
        diffViewType: "unified",
        outputFontSize: 13,
        outputContentWidth: 480,
      }).rows;

      const row = rows.find((entry) => entry.rowKind === "structured-event");
      if (!row || row.rowKind !== "structured-event" || !row.diff) {
        throw new Error("Expected a collapsed diff structured-event row");
      }
      return row;
    };

    const short = buildDiffRow("src/example.ts");
    const wrapped = buildDiffRow(
      `src/${"deeply-nested-segment/".repeat(3)}example.ts`
    );

    expect(short.diff?.isCollapsed).toBe(true);
    expect(wrapped.diff?.isCollapsed).toBe(true);
    // The `● Edited <path>` header the diff hangs under wraps to a second line;
    // that line is worth a third of a collapsed row's height, so leaving the
    // plan's tool header at a flat single line put every long-path diff row off
    // by exactly this much.
    expect(wrapped.estimateSize - short.estimateSize).toBe(
      toolCallLineHeight(13)
    );
  });

  it("adds group-boundary padding to a CLI group's first and last rows", () => {
    const { rows } = buildOutputRows({
      allMessages: [
        {
          type: "cli",
          target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
          timestamp: 1000,
          attemptIndex: 0,
          runIndex: 0,
          data: {
            prompt: "Summarize",
            response: "done",
            elapsed: 0.5,
            isStreaming: false,
          },
        },
      ],
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
      outputFontSize: 13,
      outputContentWidth: 760,
    });

    const header = rows.find((row) => row.rowKind === "cli-header");
    const stats = rows.find((row) => row.rowKind === "stats");
    if (!header || !stats) {
      throw new Error("Expected cli-header and stats rows");
    }

    // OutputRow's CLI-group wrapper adds pt-[--spacing-sm] to a group's first
    // row and pb-[--spacing-sm] + border-b to its last. cli-header and stats are
    // always those two rows, which is the whole story behind their long-standing
    // +6 / +7 estimate bias.
    expect(header.groupStart).toBe(true);
    expect(stats.groupEnd).toBe(true);
    expect(header.estimateSize).toBe(
      estimateOutputRowHeight({ ...header, groupStart: false }, 13, 760) +
        OUTPUT_ROW_GROUP_START_PADDING
    );
    expect(stats.estimateSize).toBe(
      estimateOutputRowHeight({ ...stats, groupEnd: false }, 13, 760) +
        OUTPUT_ROW_GROUP_END_PADDING
    );
  });

  it("accounts for preferred word-boundary wrapping in prompt and command rows", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const prose = Array.from(
      { length: 40 },
      (_value, index) => `argument-${index.toString().padStart(2, "0")}`
    ).join(" ");
    const packed = prose.replace(/ /g, "x");

    const prompt = (text: string) =>
      ({
        key: `prompt-${text.length}`,
        rowKind: "prompt",
        target,
        text,
        estimateSize: 0,
      }) as const;
    const command = (text: string) =>
      ({
        key: `command-${text.length}`,
        rowKind: "cli-command",
        target,
        command: text,
        wasInjected: true,
        estimateSize: 0,
      }) as const;

    expect(estimateOutputRowHeight(prompt(prose), 13, 320)).toBeGreaterThan(
      estimateOutputRowHeight(prompt(packed), 13, 320)
    );
    expect(estimateOutputRowHeight(command(prose), 13, 320)).toBeGreaterThan(
      estimateOutputRowHeight(command(packed), 13, 320)
    );
  });

  // Large plain-response rows (streaming script output) memoize their wrapped
  // line count, so the estimate must still track both the text and the layout
  // parameters rather than serving a stale cached height.
  describe("large plain-response height estimates", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const makeRow = (text: string) =>
      ({
        key: "streaming-response",
        rowKind: "plain-response",
        target,
        text,
        rawTextOutput: true,
        animated: false,
        estimateSize: 0,
      }) as const;

    // Comfortably past the 4096-char threshold that enables caching.
    const baseText = Array.from(
      { length: 400 },
      (_value, index) => `line ${index} of streaming script output`
    ).join("\n");

    it("returns a stable height for repeated calls on the same text", () => {
      const row = makeRow(baseText);
      const first = estimateOutputRowHeight(row, 13, 760);
      expect(estimateOutputRowHeight(row, 13, 760)).toBe(first);
      expect(estimateOutputRowHeight(makeRow(baseText), 13, 760)).toBe(first);
    });

    it("grows when the streamed text grows under the same row key", () => {
      const before = estimateOutputRowHeight(makeRow(baseText), 13, 760);
      const after = estimateOutputRowHeight(
        makeRow(`${baseText}\n${baseText}`),
        13,
        760
      );
      expect(after).toBeGreaterThan(before);
    });

    it("recomputes when the content width changes for the same text", () => {
      const wide = estimateOutputRowHeight(makeRow(baseText), 13, 1600);
      const narrow = estimateOutputRowHeight(makeRow(baseText), 13, 320);
      expect(narrow).toBeGreaterThan(wide);
    });

    it("recomputes when the font size changes for the same text", () => {
      const small = estimateOutputRowHeight(makeRow(baseText), 11, 760);
      const large = estimateOutputRowHeight(makeRow(baseText), 20, 760);
      expect(large).toBeGreaterThan(small);
    });
  });

  // Script output has no structured events, so it used to collapse into one
  // unbounded plain-response row that the virtualizer could not page and that
  // re-laid-out in full on every append.
  describe("script output rows", () => {
    const scriptLines = (count: number) =>
      Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(
        "\n"
      );

    const buildScriptRows = (
      options: {
        streaming?: string;
        response?: string;
        scriptOutputExpansionState?: Map<string, boolean>;
      } = {}
    ) =>
      buildOutputRows({
        allMessages: [
          {
            type: "cli",
            target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
            timestamp: 1000,
            phase: EXECUTION_PHASES.PRE_CONDITION,
            attemptIndex: 0,
            runIndex: 0,
            data: {
              prompt: "Run the condition",
              cliCommand: "npm test",
              response: options.response ?? "",
              elapsed: 0,
              isStreaming: options.streaming !== undefined,
              source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
            },
          },
        ],
        steps,
        finalStep: null,
        streamingChunks:
          options.streaming !== undefined
            ? {
                [getStreamingChunkKey(0, EXECUTION_PHASES.PRE_CONDITION)]:
                  options.streaming,
              }
            : {},
        finalStepStreamingChunks: {},
        isExecutionActive: options.streaming !== undefined,
        allowUndoActions: false,
        isViewingHistory: false,
        historyOutputs: null,
        workspaceSnapshots: {},
        finalStepWorkspaceSnapshots: {},
        undoRecords: {},
        diffCollapseState: new Map(),
        diffExpansionState: new Map(),
        toolCallExpansionState: new Map(),
        scriptOutputExpansionState: options.scriptOutputExpansionState,
        defaultDiffCollapsed: false,
        outputContentWidth: 760,
        outputFontSize: 13,
      });

    const scriptRows = (result: ReturnType<typeof buildOutputRows>) =>
      result.rows.filter((row) => row.rowKind === "script-output");

    it("sanitizes streamed and completed script output before row rendering", () => {
      const raw = "\u001b[36mcyan\u001b[39m\r\nnext\u0007";

      for (const result of [
        buildScriptRows({ streaming: raw }),
        buildScriptRows({ response: raw }),
      ]) {
        const rows = scriptRows(result);
        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe("cyan\nnext");
        expect(rows[0].text).not.toMatch(
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
        );
      }
    });

    it("splits completed output into bounded slices that rejoin to the original", () => {
      const response = scriptLines(SCRIPT_OUTPUT_LINES_PER_ROW * 3 + 4);
      const rows = scriptRows(buildScriptRows({ response }));

      expect(rows).toHaveLength(4);
      expect(rows.map((row) => row.text).join("\n")).toBe(response);
      for (const row of rows) {
        expect(row.text.split("\n").length).toBeLessThanOrEqual(
          SCRIPT_OUTPUT_LINES_PER_ROW
        );
      }
      // Completed output has stopped changing, so nothing is withheld.
      expect(rows.some((row) => row.tailToggle)).toBe(false);
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    });

    it("marks only the outer slices so the block's chrome is charged once", () => {
      const rows = scriptRows(
        buildScriptRows({
          response: scriptLines(SCRIPT_OUTPUT_LINES_PER_ROW * 3),
        })
      );

      expect(rows.map((row) => row.isFirstSegment)).toEqual([
        true,
        false,
        false,
      ]);
      expect(rows.map((row) => row.isLastSegment)).toEqual([
        false,
        false,
        true,
      ]);
    });

    it("shows only the trailing window while the script is still running", () => {
      const streaming = scriptLines(SCRIPT_OUTPUT_LINES_PER_ROW + 12);
      const rows = scriptRows(buildScriptRows({ streaming }));

      expect(rows).toHaveLength(1);
      expect(rows[0].text.split("\n")).toHaveLength(
        SCRIPT_OUTPUT_LINES_PER_ROW
      );
      expect(rows[0].text).toContain(
        `line ${SCRIPT_OUTPUT_LINES_PER_ROW + 12}`
      );
      expect(rows[0].text.startsWith("line 1\n")).toBe(false);
      expect(rows[0].tailToggle).toMatchObject({
        hiddenLineCount: 12,
        expanded: false,
      });
    });

    it("streams without a toggle until there is something to hide", () => {
      const rows = scriptRows(
        buildScriptRows({ streaming: scriptLines(SCRIPT_OUTPUT_LINES_PER_ROW) })
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].tailToggle).toBeUndefined();
    });

    it("reveals the full stream once the tail toggle is expanded", () => {
      const streaming = scriptLines(SCRIPT_OUTPUT_LINES_PER_ROW * 2 + 5);
      const collapsed = scriptRows(buildScriptRows({ streaming }));
      const toggleKey = collapsed[0].tailToggle?.key;
      expect(toggleKey).toBeDefined();

      const expanded = scriptRows(
        buildScriptRows({
          streaming,
          scriptOutputExpansionState: new Map([[toggleKey ?? "", true]]),
        })
      );

      expect(expanded).toHaveLength(3);
      expect(expanded.map((row) => row.text).join("\n")).toBe(streaming);
      // The toggle rides the last slice in both states so it stays put on screen.
      expect(expanded[expanded.length - 1].tailToggle).toMatchObject({
        expanded: true,
      });
      expect(expanded.slice(0, -1).some((row) => row.tailToggle)).toBe(false);
      // Disjoint keys: a reused key would keep the measured height of the text
      // it held in the other state.
      const collapsedKeys = new Set(collapsed.map((row) => row.key));
      expect(expanded.some((row) => collapsedKeys.has(row.key))).toBe(false);
    });

    it("splits the block's vertical chrome across the outer slices", () => {
      const split = scriptRows(
        buildScriptRows({
          response: scriptLines(SCRIPT_OUTPUT_LINES_PER_ROW * 2),
        })
      );
      const single = scriptRows(
        buildScriptRows({ response: scriptLines(SCRIPT_OUTPUT_LINES_PER_ROW) })
      );

      // Two slices of N lines cost about the same as the one row they replaced,
      // rather than paying the block chrome twice.
      const combined = split[0].estimateSize + split[1].estimateSize;
      expect(combined).toBeGreaterThan(single[0].estimateSize);
      expect(combined).toBeLessThan(single[0].estimateSize * 2);
    });

    it("leaves non-script responses as a single row", () => {
      const result = buildOutputRows({
        allMessages: [
          {
            type: "cli",
            target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
            timestamp: 1000,
            attemptIndex: 0,
            runIndex: 0,
            data: {
              prompt: "Explain",
              response: scriptLines(SCRIPT_OUTPUT_LINES_PER_ROW * 2),
              elapsed: 1,
              isStreaming: false,
            },
          },
        ],
        steps,
        finalStep: null,
        streamingChunks: {},
        finalStepStreamingChunks: {},
        isExecutionActive: false,
        allowUndoActions: false,
        isViewingHistory: false,
        historyOutputs: null,
        workspaceSnapshots: {},
        finalStepWorkspaceSnapshots: {},
        undoRecords: {},
        diffCollapseState: new Map(),
        diffExpansionState: new Map(),
        toolCallExpansionState: new Map(),
        defaultDiffCollapsed: false,
      });

      expect(scriptRows(result)).toHaveLength(0);
      expect(
        result.rows.filter((row) => row.rowKind === "plain-response")
      ).toHaveLength(1);
    });
  });
});
