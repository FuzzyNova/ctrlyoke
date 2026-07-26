import { describe, expect, it } from "vitest";
import type { WorkflowStep } from "@store/workflowStore";
import { buildOutputRows, estimateOutputRowHeight } from "@utils/outputRows";
import type { OutputMessage } from "@utils/outputProjection";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";
import {
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
  SCRIPT_OUTPUT_SOURCES,
  getStreamingChunkKey,
} from "@/types/messages";

describe("outputRows", () => {
  const steps = [{ name: "Analyze code" } as WorkflowStep];

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
      "plain-response",
      "script-verdict",
      "stats",
    ]);
    const verdictRow = result.rows.find(
      (row) => row.rowKind === "script-verdict"
    );
    expect(verdictRow?.estimateSize).toBeGreaterThan(0);
    expect(verdictRow).toMatchObject({ expanded: false });
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
        .filter((row) => row.rowKind === "plain-response")
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
    expect(baseToolRow.toolCall.renderPlan.output.visibleLineCount).toBe(10);
    expect(baseToolRow.toolCall.renderPlan.output.hiddenLineCount).toBe(2);
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

    expect(bashRow.estimateSize).toBeGreaterThan(120);
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
});
