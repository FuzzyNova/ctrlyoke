import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OutputRow } from "@components/output/OutputRow";
import type { OutputRenderRow, StructuredEventRow } from "@utils/outputRows";
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
} from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";

afterEach(() => {
  useSettingsStore.setState({ fullGlobalSettings: null });
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
    rowKind: "structured-event",
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
    rowKind: "structured-event",
    event: {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      data: { name, parameters: {}, result },
    },
    eventIndex: 0,
    rawTextOutput: false,
    attemptIndex: 0,
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
    rowKind: "stats",
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

  it("hides cost when the setting is enabled", () => {
    useSettingsStore.setState({
      fullGlobalSettings: { settings: { ui: { hideCost: true } } } as never,
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

describe("OutputRow script commands", () => {
  it("renders the working-directory prefix with the script border", () => {
    const row: OutputRenderRow = {
      key: "row-script-command",
      target: TARGET,
      estimateSize: 0,
      rowKind: "script-command",
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
          rowKind: "attempt-group-summary",
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

describe("OutputRow auto-expand on hidden active match", () => {
  it.each([
    ["passed", "✔ Passed"],
    ["failed", "✖ Failed"],
    ["errored", "⚠ Errored"],
  ] as const)("renders the %s verdict outcome", (outcome, label) => {
    const row: OutputRenderRow = {
      key: `verdict-${outcome}`,
      target: TARGET,
      estimateSize: 36,
      rowKind: "script-verdict",
      expanded: false,
      verdict: {
        compareSource: "auto",
        expected: "ok",
        actual: outcome === "errored" ? "spawn npm ENOENT" : "ok",
        actualSource: "stdout",
        outcome,
        matchRule: outcome === "passed" ? "exact" : "none",
        action: outcome === "failed" ? "retry" : "continue",
        durationMs: 1200,
      },
    };

    render(<OutputRow row={row} isExecutionActive={false} />);

    expect(screen.getByRole("button")).toHaveTextContent(label);
    expect(screen.getByRole("button")).toHaveTextContent("auto → stdout");
  });

  it("wraps a collapsed exit-code verdict without shrinking the actual value away", () => {
    const row: OutputRenderRow = {
      key: "verdict-exit-code",
      target: TARGET,
      estimateSize: 36,
      rowKind: "script-verdict",
      expanded: false,
      verdict: {
        compareSource: "auto",
        expected: "true",
        actual: "1",
        actualSource: "exitCode",
        exitCode: 1,
        outcome: "failed",
        matchRule: "none",
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
    expect(summary).toHaveTextContent("auto → exit code");
    expect(summary).toHaveTextContent("expected true");
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
      rowKind: "script-verdict",
      expanded: false,
      verdict: {
        compareSource: "stdout",
        expected: "PASS",
        actual,
        actualSource: "stdout",
        outcome: "failed",
        matchRule: "substring",
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
      rowKind: "cli-header",
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
      rowKind: "prompt",
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
      rowKind: "prompt",
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
      rowKind: "prompt",
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
      rowKind: "prompt",
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
      rowKind: "prompt",
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
      rowKind: "prompt",
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
      rowKind: "prompt",
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
      rowKind: "prompt",
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
      rowKind: "prompt",
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
      rowKind: "error",
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
      overrides: Partial<Extract<OutputRenderRow, { rowKind: "script-output" }>>
    ): OutputRenderRow => ({
      key: "row-script-output",
      target: TARGET,
      estimateSize: 0,
      rowKind: "script-output",
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

      fireEvent.click(screen.getByText("[show less]"));

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
