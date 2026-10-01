import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OutputRow } from "@components/output/OutputRow";
import { getStepIdentityBarStyle } from "@components/output/outputStyles";
import {
  estimateOutputRowHeight,
  type OutputRenderRow,
  type StructuredEventRow,
} from "@utils/outputRows";
import { findOutputMatches, type OutputFindMatch } from "@utils/outputFind";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";
import {
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  SCRIPT_OUTPUT_SOURCES,
  type TokenStats,
} from "@/types/messages";
import {
  ATTEMPT_COST_CONFIDENCE,
  ATTEMPT_COST_SOURCES,
  OUTPUT_ROW_KINDS,
  SCRIPT_VERDICT_OUTCOMES,
  STEP_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { capToolOutputEvent } from "@root/utils/ToolOutputPayload";

afterEach(() => {
  useSettingsStore.setState({ fullGlobalSettings: null });
  useUiStore.setState({ displayedViewAddress: null });
});

const TARGET = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;

function buildBashRow(
  command: string,
  output: string | undefined,
  error: string | undefined
): StructuredEventRow {
  return {
    key: "row-bash",
    target: TARGET,
    estimateSize: 0,
    rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
    event: {
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      data: {
        command,
        output,
        error,
        exitCode: error ? 1 : 0,
        status: OPERATION_STATUS.COMPLETED,
      },
    },
    eventIndex: 0,
    rawTextOutput: false,
    attemptIndex: 0,
    runIndex: 0,
    hideDiff: false,
  };
}

function buildToolCallRow(
  name: string,
  result: { success: boolean; output?: string; error?: string }
): StructuredEventRow {
  return {
    key: "row-tool",
    target: TARGET,
    estimateSize: 0,
    rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
    event: {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      data: { name, parameters: {}, result },
    },
    eventIndex: 0,
    rawTextOutput: false,
    attemptIndex: 0,
    runIndex: 0,
    hideDiff: false,
  };
}

function buildActiveMatch(
  row: StructuredEventRow,
  field: OutputFindMatch["field"],
  start: number,
  end: number
): OutputFindMatch {
  return {
    matchId: `0-${field}-${start}`,
    rowKey: row.key,
    rowIndex: 0,
    rowKind: row.rowKind,
    field,
    start,
    end,
    preview: "",
  };
}

const TWENTY_LINES = Array.from({ length: 20 }, (_, i) => `line ${i}`).join(
  "\n"
);

function buildStatsRow(tokens: TokenStats): OutputRenderRow {
  return {
    key: "row-stats",
    target: TARGET,
    estimateSize: 24,
    rowKind: OUTPUT_ROW_KINDS.STATS,
    output: {
      prompt: "prompt",
      response: "response",
      elapsed: 1,
      isStreaming: false,
      tokens,
    },
  };
}

describe("OutputRow token stats", () => {
  it("fetches complete tool output before copying the row output", async () => {
    const fullOutput = `${"copy head\n".repeat(40_000)}FULL_COPY_MARKER`;
    const cappedEvent = capToolOutputEvent({
      type: CLI_EVENT_TYPES.TOOL_RESULT,
      data: {
        toolCallId: "copy-tool",
        result: { success: true, output: fullOutput },
      },
    });
    const output = {
      prompt: "prompt",
      response: "",
      elapsed: 1,
      isStreaming: false,
      structured: { events: [cappedEvent], metadata: {} },
    };
    const row: OutputRenderRow = {
      key: "copy-stats",
      target: TARGET,
      estimateSize: 24,
      rowKind: OUTPUT_ROW_KINDS.STATS,
      output,
      outputText: "head only",
      attemptIndex: 1,
      runIndex: 0,
    };
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "run-2026-10-01T00-00-00-000Z" as never,
      },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const postMessage = vi.spyOn(window.vscodeApi!, "postMessage");
    postMessage.mockImplementation((request: any) => {
      if (request.type !== MESSAGE_TYPES.REQUEST_TOOL_OUTPUT_CONTENT) return;
      window.setTimeout(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: MESSAGE_TYPES.TOOL_OUTPUT_CONTENT,
              requestId: request.requestId,
              events: request.events.map((identity: any) => ({
                ...identity,
                event: {
                  type: CLI_EVENT_TYPES.TOOL_RESULT,
                  data: {
                    toolCallId: "copy-tool",
                    result: { success: true, output: fullOutput },
                  },
                },
              })),
            },
          })
        );
      }, 0);
    });

    render(<OutputRow row={row} isExecutionActive={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy output to clipboard" })
    );

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MESSAGE_TYPES.REQUEST_TOOL_OUTPUT_CONTENT,
          events: expect.arrayContaining([
            expect.objectContaining({
              attemptIndex: 1,
              runIndex: 0,
              eventIndex: 0,
            }),
          ]),
        })
      );
    });
    expect(writeText).toHaveBeenCalledWith("head only");
    postMessage.mockRestore();
  });

  it("shows current context without inventing a visible total", () => {
    const { container } = render(
      <OutputRow
        row={buildStatsRow({
          contextWindowUsed: 10000,
          contextWindowSize: 200000,
        } as TokenStats)}
        isExecutionActive={false}
      />
    );

    expect(container).toHaveTextContent("Context: 10k/200k (5%)");
    expect(container).not.toHaveTextContent("Total:");
  });

  it("uses the provider total when there is no current context window", () => {
    const { container } = render(
      <OutputRow
        row={buildStatsRow({
          prompt: 8000,
          completion: 2000,
          total: 410000,
          cached: 390000,
        })}
        isExecutionActive={false}
      />
    );

    expect(container).toHaveTextContent("Tokens: 8k in / 2k out / 410k total");
    expect(container).not.toHaveTextContent("Total: 10k");
    expect(
      container.querySelector("[title*='Attempt total: 410k']")
    ).not.toBeNull();
  });

  it("renders a source-labelled cost and omits unavailable dollars", () => {
    const { container } = render(
      <OutputRow
        row={buildStatsRow({
          prompt: 8000,
          completion: 2000,
          total: 10000,
          cost: {
            usd: 0.41,
            source: ATTEMPT_COST_SOURCES.PRICE_TABLE,
            confidence: ATTEMPT_COST_CONFIDENCE.COMPLETE,
          },
        })}
        isExecutionActive={false}
      />
    );

    expect(container).toHaveTextContent("≈$0.41");
    expect(
      container.querySelector("[title*='API list prices']")
    ).not.toBeNull();
    expect(container).not.toHaveTextContent("$0.00");
  });

  it("hides cost when the setting is disabled", () => {
    useSettingsStore.setState({
      fullGlobalSettings: {
        settings: { ui: { showCostEstimates: false } },
      } as never,
    });
    const { container } = render(
      <OutputRow
        row={buildStatsRow({
          prompt: 1000,
          completion: 1000,
          total: 2000,
          cost: {
            usd: 0.41,
            source: ATTEMPT_COST_SOURCES.PRICE_TABLE,
            confidence: ATTEMPT_COST_CONFIDENCE.COMPLETE,
          },
        })}
        isExecutionActive={false}
      />
    );

    expect(container).not.toHaveTextContent("$0.41");
  });
});

describe("OutputRow snapshot diffs", () => {
  it("fetches snapshot before-content when an indexed diff is expanded", async () => {
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: "run",
        runRef: "run-2026-01-01T00-00-00-000Z" as never,
      },
    });
    const row: StructuredEventRow = {
      key: "indexed-file-edit",
      target: TARGET,
      estimateSize: 80,
      rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
      event: {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        data: {
          path: "src/example.ts",
          newContent: "new value",
          status: OPERATION_STATUS.COMPLETED,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-old value", "+new value"],
            },
          ],
        },
      },
      eventIndex: 0,
      rawTextOutput: false,
      attemptIndex: 0,
      hideDiff: false,
      diff: {
        key: "indexed-file-edit-diff",
        addedLines: 1,
        removedLines: 1,
        runs: [],
        isCollapsed: true,
        renderPlan: { viewType: "unified" } as never,
      },
      workspaceSnapshot: {
        capturedAt: 1,
        strategy: "filesystem",
        changedFiles: [
          {
            path: "src/example.ts",
            changeType: "modified",
            contentAvailableOnDemand: true,
          },
        ],
      },
    };

    const view = render(
      <OutputRow
        row={row}
        isExecutionActive={false}
        onDiffCollapsedChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle diff" }));
    const request = postMessage.mock.calls[0]?.[0] as
      { type: string; requestId: string } | undefined;
    expect(request?.type).toBe(
      MESSAGE_TYPES.REQUEST_WORKSPACE_SNAPSHOT_CONTENT
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
          requestId: request?.requestId,
          beforeContent: "old value",
        },
      })
    );
    view.rerender(
      <OutputRow
        row={{ ...row, diff: { ...row.diff!, isCollapsed: false } }}
        isExecutionActive={false}
        onDiffCollapsedChange={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain("old value");
    });
  });
});

describe("OutputRow script commands", () => {
  it("renders the working-directory prefix with the script border", () => {
    const row: OutputRenderRow = {
      key: "row-script-command",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.SCRIPT_COMMAND,
      command: "npm test",
      workingDirectory: "/workspace",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );

    expect(container).toHaveTextContent("/workspace> npm test");
    expect(
      container.querySelector(".border-l-output-script-border")
    ).not.toBeNull();
  });
});

describe("OutputRow collapsed attempt groups", () => {
  it("labels the aggregate with the number of attempts", () => {
    const onToggle = vi.fn();
    render(
      <OutputRow
        row={{
          key: "attempt-group-summary",
          target: TARGET,
          estimateSize: 36,
          rowKind: OUTPUT_ROW_KINDS.ATTEMPT_GROUP_SUMMARY,
          groupKey: "queue:0:run0",
          attemptCount: 3,
          total: 410_000,
          coverage: "complete",
        }}
        isExecutionActive={false}
        onAttemptGroupToggle={onToggle}
      />
    );

    expect(screen.getByText("3 attempts · 410k total")).toBeInTheDocument();
    screen.getByRole("button", { name: /Expand 3 attempts/ }).click();
    expect(onToggle).toHaveBeenCalledWith("queue:0:run0");
  });
});

describe("OutputRow hidden steps", () => {
  it("shows the step label and toggles the hidden target", () => {
    useUiStore.getState().clearHiddenOutputTargets("_shell");
    const row: OutputRenderRow = {
      key: "queue:2:hidden",
      target: { kind: FINAL_STEP_PHASES.QUEUE, index: 2 },
      estimateSize: 40,
      rowKind: OUTPUT_ROW_KINDS.STEP_HIDDEN,
      stepLabel: "Step 3",
      stepName: "research-db",
    };

    render(<OutputRow row={row} isExecutionActive={false} />);

    expect(
      screen.getByText("Step 3 · research-db · hidden")
    ).toBeInTheDocument();
    const showButtons = screen.getAllByRole("button", {
      name: "Show output for Step 3 · research-db",
    });
    expect(showButtons).toHaveLength(2);

    fireEvent.click(showButtons[0]);
    expect(useUiStore.getState().hiddenOutputTargets._shell?.keys).toEqual([
      "queue:2",
    ]);
    fireEvent.click(showButtons[1]);
    expect(useUiStore.getState().hiddenOutputTargets).toEqual({});
  });

  it("reveals the activity indicator only while the hidden step is active", () => {
    const row: OutputRenderRow = {
      key: "queue:2:hidden",
      target: { kind: FINAL_STEP_PHASES.QUEUE, index: 2 },
      estimateSize: 40,
      rowKind: OUTPUT_ROW_KINDS.STEP_HIDDEN,
      stepLabel: "Step 3",
      stepName: "research-db",
    };

    const { container, rerender } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );
    expect(
      container.querySelector("[data-hidden-output-activity]")
    ).toHaveClass("invisible");

    rerender(<OutputRow row={row} isExecutionActive hasHiddenActivity />);
    expect(
      container.querySelector("[data-hidden-output-activity]")
    ).not.toHaveClass("invisible");
  });
});

describe("OutputRow step identity bar", () => {
  it("paints the bar on both row wrapper paths without changing height estimates", () => {
    const stepColor = "#123456";
    const cliRow = {
      ...buildStatsRow({ prompt: 0, completion: 0, total: 1 }),
      stepColor,
    };
    const nonCliRow: OutputRenderRow = {
      key: "queue:0:anchor",
      target: TARGET,
      estimateSize: 1,
      rowKind: OUTPUT_ROW_KINDS.STEP_ANCHOR,
    };
    const { container, rerender } = render(
      <OutputRow row={cliRow} isExecutionActive={false} />
    );

    const cliBar = container.querySelector("[data-step-color-bar]");
    expect(cliBar).toHaveStyle(getStepIdentityBarStyle(stepColor));
    expect(cliBar).not.toHaveStyle({ boxShadow: `inset 3px 0 0 ${stepColor}` });

    rerender(
      <OutputRow row={{ ...nonCliRow, stepColor }} isExecutionActive={false} />
    );
    const nonCliBar = container.querySelector("[data-step-color-bar]");
    expect(nonCliBar).toHaveStyle(getStepIdentityBarStyle(stepColor));
    expect(nonCliRow.estimateSize).toBe(1);
    expect(estimateOutputRowHeight(cliRow, 13, 760)).toBe(
      estimateOutputRowHeight(
        buildStatsRow({ prompt: 0, completion: 0, total: 1 }),
        13,
        760
      )
    );
  });

  it("keeps a status severity border beside the identity bar", () => {
    const statusRow: OutputRenderRow = {
      key: "queue:0:status",
      target: TARGET,
      estimateSize: 36,
      rowKind: OUTPUT_ROW_KINDS.STATUS,
      status: {
        message:
          "A warning message long enough to wrap in a narrow output pane",
        severity: "warning",
        timestamp: "12:00:00",
        timestampMs: 0,
      },
      stepColor: "#123456",
    };

    const { container } = render(
      <OutputRow row={statusRow} isExecutionActive={false} />
    );

    const identityBar = container.querySelector("[data-step-color-bar]");
    const severityBorder = container.querySelector(
      ".border-l-severity-warning"
    );
    expect(identityBar).toHaveClass("pl-[6px]");
    expect(identityBar).toHaveStyle(getStepIdentityBarStyle("#123456"));
    expect(severityBorder).not.toBeNull();
    expect(identityBar).not.toHaveClass("border-l-severity-warning");
    expect(severityBorder).not.toBe(identityBar);
    expect(severityBorder?.parentElement).toBe(identityBar);
    expect(statusRow.estimateSize).toBe(36);
  });

  it("keeps the pre-existing bare render when no step color is set", () => {
    const statusRow: OutputRenderRow = {
      key: "queue:0:status-no-color",
      target: TARGET,
      estimateSize: 36,
      rowKind: OUTPUT_ROW_KINDS.STATUS,
      status: {
        message: "Informational status",
        severity: "info",
        timestamp: "12:00:00",
        timestampMs: 0,
      },
    };

    const { container } = render(
      <OutputRow row={statusRow} isExecutionActive={false} />
    );

    expect(container.querySelector("[data-step-color-bar]")).toBeNull();
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toHaveClass("border-l-severity-info");
  });
});

describe("OutputRow activity attribution label", () => {
  function buildActivityLabelRow(
    overrides: Partial<OutputRenderRow>
  ): OutputRenderRow {
    return {
      key: "queue:0:activity",
      target: TARGET,
      estimateSize: 24,
      rowKind: OUTPUT_ROW_KINDS.STEP_ANCHOR,
      activityFirst: true,
      activityLabel: "Step 1",
      activityName: "research-auth",
      ...overrides,
    } as OutputRenderRow;
  }

  it("draws the step kind glyph in the step identity color", () => {
    const stepColor = "#123456";
    const { container, rerender } = render(
      <OutputRow
        row={buildActivityLabelRow({
          activityStepType: STEP_TYPES.PROMPT,
          stepColor,
        })}
        isExecutionActive={false}
      />
    );

    const promptIcon = container.querySelector(".codicon-comment");
    expect(promptIcon).not.toBeNull();
    expect(container.querySelector(".codicon-symbol-event")).toBeNull();
    expect(promptIcon).toHaveStyle({ color: stepColor });

    rerender(
      <OutputRow
        row={buildActivityLabelRow({
          activityStepType: STEP_TYPES.SCRIPT,
          stepColor,
        })}
        isExecutionActive={false}
      />
    );
    expect(
      container.querySelector(".codicon-terminal-powershell")
    ).not.toBeNull();
    expect(container.querySelector(".codicon-comment")).toBeNull();
  });

  it("falls back to the neutral glyph treatment when step colors are off", () => {
    const { container } = render(
      <OutputRow
        row={buildActivityLabelRow({ activityStepType: STEP_TYPES.PROMPT })}
        isExecutionActive={false}
      />
    );

    const promptIcon = container.querySelector(".codicon-comment");
    expect(promptIcon).toHaveClass("text-description-fg");
    expect(promptIcon?.getAttribute("style")).toBeNull();
  });
});

describe("OutputRow auto-expand on hidden active match", () => {
  it("fetches the complete bash output when a capped row expands", async () => {
    const fullOutput = `${"visible head\n".repeat(40_000)}FULL_TAIL_MARKER`;
    const cappedEvent = capToolOutputEvent({
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      data: {
        command: "cat log",
        output: fullOutput,
        status: OPERATION_STATUS.COMPLETED,
      },
    });
    const row: StructuredEventRow = {
      ...buildBashRow("cat log", undefined, undefined),
      event: cappedEvent,
      eventIndex: 0,
      attemptIndex: 3,
      runIndex: 2,
    };
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "run-2026-10-01T00-00-00-000Z" as never,
      },
    });
    const postMessage = vi.spyOn(window.vscodeApi!, "postMessage");
    postMessage.mockImplementation((request: any) => {
      if (request.type !== MESSAGE_TYPES.REQUEST_TOOL_OUTPUT_CONTENT) return;
      window.setTimeout(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: MESSAGE_TYPES.TOOL_OUTPUT_CONTENT,
              requestId: request.requestId,
              events: request.events.map((identity: any) => ({
                ...identity,
                event: {
                  type: CLI_EVENT_TYPES.BASH_COMMAND,
                  data: {
                    command: "cat log",
                    output: fullOutput,
                    status: OPERATION_STATUS.COMPLETED,
                  },
                },
              })),
            },
          })
        );
      }, 0);
    });

    render(<OutputRow row={row} isExecutionActive={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: /show \d+ more lines/i })
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading full output");

    expect(await screen.findByText(/FULL_TAIL_MARKER/)).toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            attemptIndex: 3,
            runIndex: 2,
            eventIndex: 0,
          }),
        ]),
      })
    );
    postMessage.mockRestore();
  });

  it("fetches a capped standalone tool result when it expands", async () => {
    const fullOutput = `${"tool head\n".repeat(40_000)}FULL_TOOL_RESULT_MARKER`;
    const cappedEvent = capToolOutputEvent({
      type: CLI_EVENT_TYPES.TOOL_RESULT,
      data: {
        toolCallId: "tool-1",
        result: { success: true, output: fullOutput },
      },
    });
    const row: StructuredEventRow = {
      key: "row-tool-result",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
      event: cappedEvent,
      eventIndex: 4,
      rawTextOutput: false,
      attemptIndex: 1,
      runIndex: 0,
      hideDiff: false,
    };
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "run-2026-10-01T00-00-00-000Z" as never,
      },
    });
    const postMessage = vi.spyOn(window.vscodeApi!, "postMessage");
    postMessage.mockImplementation((request: any) => {
      if (request.type !== MESSAGE_TYPES.REQUEST_TOOL_OUTPUT_CONTENT) return;
      window.setTimeout(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: MESSAGE_TYPES.TOOL_OUTPUT_CONTENT,
              requestId: request.requestId,
              events: request.events.map((identity: any) => ({
                ...identity,
                event: {
                  type: CLI_EVENT_TYPES.TOOL_RESULT,
                  data: {
                    toolCallId: "tool-1",
                    result: { success: true, output: fullOutput },
                  },
                },
              })),
            },
          })
        );
      }, 0);
    });

    render(<OutputRow row={row} isExecutionActive={false} />);
    fireEvent.click(screen.getByRole("button", { name: /show more/i }));

    expect(
      await screen.findByText(/FULL_TOOL_RESULT_MARKER/)
    ).toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            attemptIndex: 1,
            runIndex: 0,
            eventIndex: 4,
          }),
        ]),
      })
    );
    postMessage.mockRestore();
  });

  it.each([
    [SCRIPT_VERDICT_OUTCOMES.PASSED, "✔ Passed"],
    [SCRIPT_VERDICT_OUTCOMES.FAILED, "✖ Failed"],
    [SCRIPT_VERDICT_OUTCOMES.ERRORED, "⚠ Errored"],
  ] as const)("renders the %s verdict outcome", (outcome, label) => {
    const row: OutputRenderRow = {
      key: `verdict-${outcome}`,
      target: TARGET,
      estimateSize: 36,
      rowKind: OUTPUT_ROW_KINDS.SCRIPT_VERDICT,
      expanded: false,
      verdict: {
        compareSource: "stdout",
        operator: "eq",
        expected: "ok",
        actual:
          outcome === SCRIPT_VERDICT_OUTCOMES.ERRORED
            ? "spawn npm ENOENT"
            : "ok",
        outcome,
        action:
          outcome === SCRIPT_VERDICT_OUTCOMES.FAILED ? "retry" : "continue",
        durationMs: 1200,
      },
    };

    render(<OutputRow row={row} isExecutionActive={false} />);

    expect(screen.getByRole("button")).toHaveTextContent(label);
    expect(screen.getByRole("button")).toHaveTextContent("stdout == ok");
  });

  it("wraps a collapsed exit-code verdict without shrinking the actual value away", () => {
    const row: OutputRenderRow = {
      key: "verdict-exit-code",
      target: TARGET,
      estimateSize: 36,
      rowKind: OUTPUT_ROW_KINDS.SCRIPT_VERDICT,
      expanded: false,
      verdict: {
        compareSource: "exitCode",
        operator: "eq",
        expected: "0",
        actual: "1",
        exitCode: 1,
        outcome: SCRIPT_VERDICT_OUTCOMES.FAILED,
        action: "stopWorkflow",
        durationMs: 130_600,
      },
    };

    render(<OutputRow row={row} isExecutionActive={false} />);

    const summary = screen.getByRole("button");
    expect(summary).toHaveClass(
      "whitespace-normal",
      "[overflow-wrap:anywhere]"
    );
    expect(summary).not.toHaveClass("overflow-hidden");
    expect(summary).toHaveTextContent("exit code == 0");
    expect(summary).toHaveTextContent("actual 1");
    expect(summary).toHaveTextContent("stopWorkflow");
    expect(summary).toHaveTextContent("130.6s");
    expect(summary.querySelector(".truncate")).toBeNull();
  });

  it("truncates long actual values while collapsed and reveals them when expanded", () => {
    const actual = Array.from(
      { length: 20 },
      (_, index) => `line ${index}`
    ).join("\n");
    const row: OutputRenderRow = {
      key: "verdict-truncated",
      target: TARGET,
      estimateSize: 36,
      rowKind: OUTPUT_ROW_KINDS.SCRIPT_VERDICT,
      expanded: false,
      verdict: {
        compareSource: "stdout",
        operator: "eq",
        expected: "PASS",
        actual,
        outcome: SCRIPT_VERDICT_OUTCOMES.FAILED,
        action: "stopWorkflow",
        durationMs: 100,
      },
    };

    const { container, rerender } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );
    expect(screen.getByRole("button")).toHaveTextContent("line 0");
    expect(screen.getByRole("button")).not.toHaveTextContent("line 19");

    fireEvent.click(screen.getByRole("button"));
    rerender(
      <OutputRow row={{ ...row, expanded: true }} isExecutionActive={false} />
    );
    expect(container).toHaveTextContent("line 19");
  });

  it.each([
    [SCRIPT_OUTPUT_SOURCES.PRE_CONDITION, 0, "Pre-condition"],
    [SCRIPT_OUTPUT_SOURCES.END_CONDITION, 0, "End condition"],
    [SCRIPT_OUTPUT_SOURCES.END_CONDITION, 1, "End condition retry 2"],
  ])("labels %s output as %s", (source, attemptIndex, label) => {
    const row: OutputRenderRow = {
      key: `header-${source}-${attemptIndex}`,
      target: TARGET,
      estimateSize: 44,
      rowKind: OUTPUT_ROW_KINDS.CLI_HEADER,
      output: {
        prompt: "",
        response: "",
        cliCommand: "npm test",
        elapsed: 0,
        isStreaming: true,
        source,
      },
      stepIndex: 0,
      isFinalStep: false,
      stepLabel: "Step 1",
      attemptIndex,
      runIndex: 0,
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={true} />
    );

    expect(container).toHaveTextContent(label);
  });

  it("renders one neutral change viewer for mixed step state", () => {
    const onPromptView = vi.fn();
    const row: OutputRenderRow = {
      key: "header-view-changes",
      target: TARGET,
      estimateSize: 44,
      rowKind: OUTPUT_ROW_KINDS.CLI_HEADER,
      output: {
        prompt: "Edit files",
        response: "done",
        elapsed: 0,
        isStreaming: false,
      },
      stepIndex: 0,
      isFinalStep: false,
      stepLabel: "Step 1",
      attemptIndex: 0,
      runIndex: 0,
      promptUndo: {
        workspacePath: "/repo",
        allStepOutputs: [],
        summary: {
          total: 2,
          undoable: 1,
          undone: 1,
          blocked: 0,
          label: "View 2 changes (1 undone)",
          compactLabel: "View 2",
          title: "2 files changed · 1 undone, can be redone",
        },
      },
    };

    render(
      <OutputRow
        row={row}
        isExecutionActive={false}
        onPromptView={onPromptView}
      />
    );

    const button = screen.getByRole("button", {
      name: "View 2 changes (1 undone)",
    });
    expect(button).toHaveClass("text-link-fg");
    expect(button.querySelector(".codicon-diff")).toBeInTheDocument();
    expect(button.querySelector(".text-terminal-ansiGreen")).toHaveTextContent(
      "(1 undone)"
    );
    fireEvent.click(button);
    expect(onPromptView).toHaveBeenCalledWith(row);
  });

  it("renders a change viewer when every step change is blocked", () => {
    const onPromptView = vi.fn();
    const row: OutputRenderRow = {
      key: "header-blocked-changes",
      target: TARGET,
      estimateSize: 44,
      rowKind: OUTPUT_ROW_KINDS.CLI_HEADER,
      output: {
        prompt: "Edit files",
        response: "done",
        elapsed: 0,
        isStreaming: false,
      },
      stepIndex: 0,
      isFinalStep: false,
      stepLabel: "Step 1",
      attemptIndex: 0,
      runIndex: 0,
      promptUndo: {
        workspacePath: "/repo",
        allStepOutputs: [],
        summary: {
          total: 3,
          undoable: 0,
          undone: 0,
          blocked: 3,
          label: "View 3 changes",
          compactLabel: "View 3",
          title: "3 files changed",
        },
      },
    };

    render(
      <OutputRow
        row={row}
        isExecutionActive={false}
        onPromptView={onPromptView}
      />
    );

    const button = screen.getByRole("button", {
      name: "View 3 changes",
    });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onPromptView).toHaveBeenCalledWith(row);
  });

  it("expands a truncated bash command when the active match is hidden", () => {
    const command = `node -e "${"x".repeat(220)} target"`;
    const row = buildBashRow(command, undefined, undefined);
    const localStart = command.indexOf("target");
    const activeMatch = buildActiveMatch(
      row,
      "command",
      localStart,
      localStart + "target".length
    );
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [
            {
              start: localStart,
              end: localStart + "target".length,
              active: true,
            },
          ],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).toHaveBeenCalledWith(
      "row-bash",
      "command",
      true
    );
  });

  it("expands bash output when the active match is hidden behind 'show more'", () => {
    const command = "cat";
    const row = buildBashRow(command, TWENTY_LINES, undefined);
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = command.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch = buildActiveMatch(
      row,
      "response",
      globalStart,
      globalEnd
    );
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).toHaveBeenCalledWith(
      "row-bash",
      "output",
      true
    );
  });

  it("expands bash error output when the active match is hidden behind 'show more'", () => {
    const command = "cat";
    const row = buildBashRow(command, undefined, TWENTY_LINES);
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = command.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch = buildActiveMatch(row, "error", globalStart, globalEnd);
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).toHaveBeenCalledWith(
      "row-bash",
      "error",
      true
    );
  });

  it("does not expand bash output when the active match is already visible", () => {
    const command = "cat";
    const row = buildBashRow(command, TWENTY_LINES, undefined);
    const localStart = TWENTY_LINES.indexOf("line 0");
    const globalStart = command.length + 1 + localStart;
    const globalEnd = globalStart + "line 0".length;
    const activeMatch = buildActiveMatch(
      row,
      "response",
      globalStart,
      globalEnd
    );
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).not.toHaveBeenCalled();
  });

  it("does not expand when the row is not the active find row", () => {
    const command = "cat";
    const row = buildBashRow(command, TWENTY_LINES, undefined);
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = command.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch: OutputFindMatch = {
      ...buildActiveMatch(row, "response", globalStart, globalEnd),
      rowKey: "some-other-row",
    };
    const onBashExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: false }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        bashExpansion={{
          commandExpanded: false,
          outputExpanded: false,
          errorExpanded: false,
        }}
        onBashExpansionChange={onBashExpansionChange}
      />
    );

    expect(onBashExpansionChange).not.toHaveBeenCalled();
  });

  it("expands tool call output when the active match is hidden behind 'show more'", () => {
    const name = "Read";
    const row = buildToolCallRow(name, { success: true, output: TWENTY_LINES });
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = name.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch = buildActiveMatch(
      row,
      "toolContent",
      globalStart,
      globalEnd
    );
    const onToolCallExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        onToolCallExpansionChange={onToolCallExpansionChange}
      />
    );

    expect(onToolCallExpansionChange).toHaveBeenCalledWith(
      "row-tool",
      "output",
      true
    );
  });

  it("expands tool call error when the active match is hidden behind 'show more'", () => {
    const name = "Bash";
    const row = buildToolCallRow(name, { success: false, error: TWENTY_LINES });
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = name.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch = buildActiveMatch(
      row,
      "toolContent",
      globalStart,
      globalEnd
    );
    const onToolCallExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        onToolCallExpansionChange={onToolCallExpansionChange}
      />
    );

    expect(onToolCallExpansionChange).toHaveBeenCalledWith(
      "row-tool",
      "error",
      true
    );
  });

  it("expands tool call params when the active match is hidden behind the collapsed params toggle", () => {
    const name = "Read";
    const row: StructuredEventRow = {
      key: "row-tool-params",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
      event: {
        type: CLI_EVENT_TYPES.TOOL_CALL,
        data: {
          name,
          parameters: { path: "src/target-file.ts" },
          result: { success: true },
        },
      },
      eventIndex: 0,
      rawTextOutput: false,
      attemptIndex: 0,
      hideDiff: false,
    };
    const paramsText = "path: src/target-file.ts";
    const localStart = paramsText.indexOf("target-file");
    const globalStart = name.length + 1 + localStart;
    const globalEnd = globalStart + "target-file".length;
    const activeMatch = buildActiveMatch(row, "params", globalStart, globalEnd);
    const onToolCallExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        onToolCallExpansionChange={onToolCallExpansionChange}
      />
    );

    expect(onToolCallExpansionChange).toHaveBeenCalledWith(
      "row-tool-params",
      "params",
      true
    );
  });

  it("expands MCP tool call output when the active match is hidden behind 'show more'", () => {
    const label = "MCP: srv.Read";
    const row: StructuredEventRow = {
      key: "row-mcp",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
      event: {
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        data: {
          server: "srv",
          tool: "Read",
          parameters: {},
          result: { success: true, output: TWENTY_LINES },
        },
      },
      eventIndex: 0,
      rawTextOutput: false,
      attemptIndex: 0,
      hideDiff: false,
    };
    const localStart = TWENTY_LINES.indexOf("line 19");
    const globalStart = label.length + 1 + localStart;
    const globalEnd = globalStart + "line 19".length;
    const activeMatch = buildActiveMatch(
      row,
      "toolContent",
      globalStart,
      globalEnd
    );
    const onToolCallExpansionChange = vi.fn();

    render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: globalStart, end: globalEnd, active: true }],
        }}
        activeFindMatch={activeMatch}
        isExecutionActive={false}
        onToolCallExpansionChange={onToolCallExpansionChange}
      />
    );

    expect(onToolCallExpansionChange).toHaveBeenCalledWith(
      "row-mcp",
      "output",
      true
    );
  });

  it.each([
    {
      section: "output",
      result: { success: true, output: "alpha result" },
    },
    {
      section: "error",
      result: { success: false, error: "alpha failure" },
    },
  ])("highlights the active match in MCP tool call $section", ({ result }) => {
    const row: StructuredEventRow = {
      key: "row-mcp-highlight",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
      event: {
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        data: {
          server: "srv",
          tool: "Read",
          parameters: {},
          result,
        },
      },
      eventIndex: 0,
      rawTextOutput: false,
      attemptIndex: 0,
      hideDiff: false,
    };
    const [match] = findOutputMatches([row], "alpha", false);

    const { container } = render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: match.start, end: match.end, active: true }],
        }}
        activeFindMatch={match}
        isExecutionActive={false}
      />
    );

    const mark = container.querySelector("mark");
    expect(mark).toHaveTextContent("alpha");
    expect(mark).toHaveAttribute("data-find-active", "true");
  });

  it("highlights sanitized bash output at the rendered location", () => {
    const row = buildBashRow(
      "echo ok",
      "\u001b[31malpha\u001b[0m beta",
      undefined
    );
    const [match] = findOutputMatches([row], "alpha", false);

    const { container } = render(
      <OutputRow
        row={row}
        findDecorations={{
          matches: [{ start: match.start, end: match.end, active: true }],
        }}
        activeFindMatch={match}
        isExecutionActive={false}
      />
    );

    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("alpha");
    expect(mark).toHaveAttribute("data-find-active", "true");
  });

  it("renders ctrlyoke references in the prompt row as clickable links", () => {
    const row: OutputRenderRow = {
      key: "row-prompt",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      text: "Review @src/app.ts and #sym:src/utils.ts:runWorkflow:42-58 now",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );

    const links = container.querySelectorAll('[role="link"]');
    expect(links.length).toBe(2);
    expect(links[0].textContent).toBe("@src/app.ts");
    expect(links[1].textContent).toBe("#sym:src/utils.ts:runWorkflow:42-58");
    // Plain prose stays as text, not links.
    expect(container).toHaveTextContent(
      "Review @src/app.ts and #sym:src/utils.ts:runWorkflow:42-58 now"
    );
  });

  it("renders every prompt reference as a chip when atomic formatting is enabled", () => {
    const text =
      "@src/app.ts @src/ #selection:src/app.ts:2-4 #sym:src/app.ts:run:2-4 ~staged $previous";
    const row: OutputRenderRow = {
      key: "row-prompt-chips",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      text,
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} atomicContextReferences />
    );

    const chips = container.querySelectorAll(
      "[data-atomic-reference-copy-text]"
    );
    expect(chips).toHaveLength(6);
    expect(chips[0]).toHaveTextContent("app.ts");
    expect(chips[5]).toHaveTextContent("previous");

    fireEvent.click(chips[0]);
    expect(window.vscodeApi?.postMessage).toHaveBeenCalled();
  });

  it("renders explicit skill/mcp references as chips and opens them like other atomic references", () => {
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();
    const row: OutputRenderRow = {
      key: "row-prompt-slash-tokens",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      text: "using /skill:commit, commit just the changes with /mcp:playwright",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} atomicContextReferences />
    );

    const chips = container.querySelectorAll(
      "[data-atomic-reference-copy-text]"
    );
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("commit");
    expect(chips[0].querySelector(".codicon-tools")).not.toBeNull();
    expect(chips[1]).toHaveTextContent("playwright");
    expect(chips[1].querySelector(".codicon-mcp")).not.toBeNull();

    fireEvent.click(chips[0]);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_SKILL,
      skillName: "commit",
    });

    fireEvent.click(chips[1]);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_MCP_CONFIG_PREVIEW,
      mcpServerName: "playwright",
    });
  });

  it("keeps skill/mcp references as selectable links when atomic formatting is off", () => {
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();
    const row: OutputRenderRow = {
      key: "row-prompt-slash-tokens-plain",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      text: "/skill:commit /mcp:playwright",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );

    const links = container.querySelectorAll('[role="link"]');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent("/skill:commit");
    expect(links[0]).toHaveAttribute("title", "Open ctrlyoke skill commit");
    expect(links[1]).toHaveTextContent("/mcp:playwright");
    expect(links[1]).toHaveAttribute(
      "title",
      "Open ctrlyoke MCP server playwright in MCP Manager"
    );

    fireEvent.click(links[0]);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_SKILL,
      skillName: "commit",
    });
  });

  it("renders an embedded symbol kind in output without a host lookup", () => {
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();
    const row: OutputRenderRow = {
      key: "row-prompt-kind-chip",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      text: "Review #sym.class:src/app.ts:Widget:2-8",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} atomicContextReferences />
    );

    expect(container.querySelector(".codicon-symbol-class")).not.toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("keeps prompt references as selectable links when atomic formatting is off", () => {
    const row: OutputRenderRow = {
      key: "row-prompt-links",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      text: "Open @src/app.ts and $previous",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );

    expect(container.querySelectorAll('[role="link"]')).toHaveLength(2);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("makes echoed $context clickable in both presentation modes", () => {
    const row: OutputRenderRow = {
      key: "row-context",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      text: "Use $previous",
    };

    const plain = render(<OutputRow row={row} isExecutionActive={false} />);
    expect(plain.getByRole("link")).toHaveTextContent("$previous");
    plain.unmount();

    const chips = render(
      <OutputRow row={row} isExecutionActive={false} atomicContextReferences />
    );
    expect(chips.container.querySelector("button")).toHaveTextContent(
      "previous"
    );
  });

  it("projects find marks onto an echoed chip while preserving its full copy text", () => {
    const text = "Review @src/webview-react/app.ts";
    const row: OutputRenderRow = {
      key: "row-prompt-find",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      text,
    };
    const start = text.indexOf("webview-react");

    const { container } = render(
      <OutputRow
        row={row}
        isExecutionActive={false}
        atomicContextReferences
        findDecorations={{
          matches: [
            { start, end: start + "webview-react".length, active: true },
          ],
        }}
      />
    );

    const chip = container.querySelector("button");
    expect(chip).toHaveTextContent("webview-react");
    expect(chip).toHaveAttribute(
      "data-atomic-reference-copy-text",
      "@src/webview-react/app.ts"
    );
    expect(chip?.querySelector("mark")).toHaveTextContent("webview-react");
    expect(chip?.querySelector("mark")).toHaveAttribute(
      "data-find-active",
      "true"
    );
  });

  it("does not linkify prompt references inside fenced code blocks", () => {
    const row: OutputRenderRow = {
      key: "row-prompt-fenced",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      text: "Use @src/app.ts here\n```\n@src/ignored.ts\n```",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );

    const links = container.querySelectorAll('[role="link"]');
    expect(links.length).toBe(1);
    expect(links[0].textContent).toBe("@src/app.ts");
    // The fenced reference is still shown as plain text, just not a link.
    expect(container).toHaveTextContent("@src/ignored.ts");
  });

  it("renders legacy user-stop error rows as warnings", () => {
    const row: OutputRenderRow = {
      key: "row-error",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.ERROR,
      errorMessage: "Stopped by user",
      timestamp: "12:03:21",
    };

    const { container } = render(
      <OutputRow row={row} isExecutionActive={false} />
    );

    expect(container).toHaveTextContent("[12:03:21] Warning: Stopped by user");
    expect(container).not.toHaveTextContent(
      "[12:03:21] Error: Stopped by user"
    );
  });

  describe("script output rows", () => {
    const buildScriptOutputRow = (
      overrides: Partial<
        Extract<
          OutputRenderRow,
          { rowKind: typeof OUTPUT_ROW_KINDS.SCRIPT_OUTPUT }
        >
      >
    ): OutputRenderRow => ({
      key: "row-script-output",
      target: TARGET,
      estimateSize: 0,
      rowKind: OUTPUT_ROW_KINDS.SCRIPT_OUTPUT,
      text: "line 1\nline 2",
      isFirstSegment: true,
      isLastSegment: true,
      ...overrides,
    });

    it("renders a slice without a toggle when nothing is withheld", () => {
      const { container } = render(
        <OutputRow row={buildScriptOutputRow({})} isExecutionActive={false} />
      );

      expect(container).toHaveTextContent("line 1");
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("reports the toggle key rather than the row key when expanding", () => {
      const onScriptOutputExpansionChange = vi.fn();
      const row = buildScriptOutputRow({
        tailToggle: {
          key: "toggle-key",
          hiddenLineCount: 412,
          expanded: false,
        },
      });

      render(
        <OutputRow
          row={row}
          isExecutionActive={true}
          onScriptOutputExpansionChange={onScriptOutputExpansionChange}
        />
      );

      fireEvent.click(
        screen.getByText("[show full output — 412 earlier lines]")
      );

      expect(onScriptOutputExpansionChange).toHaveBeenCalledWith(
        "row-script-output",
        "toggle-key",
        true
      );
    });

    it("collapses back from the expanded toggle", () => {
      const onScriptOutputExpansionChange = vi.fn();

      render(
        <OutputRow
          row={buildScriptOutputRow({
            tailToggle: {
              key: "toggle-key",
              hiddenLineCount: 0,
              expanded: true,
            },
          })}
          isExecutionActive={true}
          onScriptOutputExpansionChange={onScriptOutputExpansionChange}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "[show less]" }));

      expect(onScriptOutputExpansionChange).toHaveBeenCalledWith(
        "row-script-output",
        "toggle-key",
        false
      );
    });

    it("charges block padding only to the outer slices", () => {
      const middle = render(
        <OutputRow
          row={buildScriptOutputRow({
            isFirstSegment: false,
            isLastSegment: false,
          })}
          isExecutionActive={false}
        />
      );
      const segment = middle.container.querySelector(".border-l-transparent");

      expect(segment?.className).not.toContain("pt-[var(--spacing-sm)]");
      expect(segment?.className).not.toContain("pb-[var(--spacing-sm)]");

      const only = render(
        <OutputRow row={buildScriptOutputRow({})} isExecutionActive={false} />
      );
      const onlySegment = only.container.querySelector(".border-l-transparent");

      expect(onlySegment?.className).toContain("pt-[var(--spacing-sm)]");
      expect(onlySegment?.className).toContain("pb-[var(--spacing-sm)]");
    });
  });
});
