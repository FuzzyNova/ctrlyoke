import { describe, expect, it, vi } from "vitest";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
} from "@root/types/DashboardConstants";
import type { OrderedCliHistoryEntry } from "@root/types/OutputHistoryTypes";
import { generateMarkdownExport } from "@utils/markdownExport";
import {
  hydrateOrderedCliEntries,
  hydrateOutputMessages,
} from "@utils/toolOutputHydration";
import { buildCopyAllText } from "@hooks/useOutputContextMenu";
import type { OutputMessage } from "@utils/outputProjection";
import { capToolOutputEvent } from "@root/utils/ToolOutputPayload";
import { buildCollapsedOutputPreview } from "@utils/outputTruncation";
import type { WorkflowKey, RunRef } from "@root/types/CtrlYokeTypes";

describe("tool output export hydration", () => {
  it("keeps the collapsed preview identical to the uncapped output", () => {
    const output = Array.from(
      { length: 6_000 },
      (_, index) => `line ${index}`
    ).join("\n");
    const event = capToolOutputEvent({
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      data: { command: "cmd", output },
    });
    const capped = (event.data as { output: string }).output;
    const options = {
      expanded: false,
      maxLines: 3,
      maxChars: 1_200,
      fullLineCount: event.outputTotalLines,
    };
    const uncappedOptions = { ...options, fullLineCount: undefined };
    expect(buildCollapsedOutputPreview(output, uncappedOptions)).toEqual(
      buildCollapsedOutputPreview(capped, options)
    );
    expect(options.fullLineCount).toBe(6_000);
    expect(buildCollapsedOutputPreview(capped, options).hiddenLineCount).toBe(
      5_997
    );
  });

  it("exports full tool text after fetching a capped aggregate event", async () => {
    const entry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      timestampMs: 1,
      sequence: 1,
      attemptIndex: 2,
      runIndex: 3,
      cliOutput: {
        prompt: "prompt",
        response: "",
        elapsed: 1,
        isStreaming: false,
        structured: {
          events: [
            {
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              data: {
                command: "cat file",
                output: "head",
                outputTruncated: true,
                outputTotalBytes: 14,
              },
            },
          ],
          metadata: {} as never,
        },
      },
    };
    const address = {
      workflowKey: "workflow-a" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const fetchEvent = vi.fn().mockResolvedValue({
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      data: { command: "cat file", output: "complete output" },
    });
    const hydrated = await hydrateOrderedCliEntries(
      [entry],
      address,
      fetchEvent
    );
    const markdown = generateMarkdownExport(
      [],
      {
        fileName: "workflow",
        executionState: "completed",
        currentStep: 1,
        totalSteps: 1,
      },
      {
        orderedEntries: hydrated,
        exportOptions: { includeCommand: true, includeMetadata: true },
      }
    );

    expect(fetchEvent).toHaveBeenCalledWith({
      address,
      target: entry.target,
      attemptIndex: 2,
      runIndex: 3,
      phase: undefined,
      eventIndex: 0,
    });
    expect(markdown).toContain("complete output");
    expect(markdown).not.toContain("head");
  });

  it("hydrates multiple entries through one batch call", async () => {
    const address = {
      workflowKey: "workflow-a" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const entries: OrderedCliHistoryEntry[] = [0, 1].map((stepIndex) => ({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
      timestampMs: stepIndex,
      sequence: stepIndex,
      attemptIndex: 0,
      cliOutput: {
        prompt: "prompt",
        response: "",
        elapsed: 1,
        isStreaming: false,
        structured: {
          events: [
            {
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              data: { command: "cmd", output: "head", outputTruncated: true },
            },
          ],
          metadata: {} as never,
        },
      },
    }));
    const fetchEvent = Object.assign(vi.fn(), {
      requestMany: vi.fn().mockResolvedValue([
        { type: CLI_EVENT_TYPES.BASH_COMMAND, data: { output: "full 0" } },
        { type: CLI_EVENT_TYPES.BASH_COMMAND, data: { output: "full 1" } },
      ]),
    });
    const hydrated = await hydrateOrderedCliEntries(
      entries,
      address,
      fetchEvent
    );

    expect(fetchEvent).not.toHaveBeenCalled();
    expect(fetchEvent.requestMany).toHaveBeenCalledTimes(1);
    expect(fetchEvent.requestMany.mock.calls[0]?.[0]).toHaveLength(2);
    expect(
      hydrated.map((entry) =>
        entry.kind === OUTPUT_HISTORY_KINDS.CLI
          ? (
              entry.cliOutput.structured?.events?.[0]?.data as {
                output?: string;
              }
            ).output
          : undefined
      )
    ).toEqual(["full 0", "full 1"]);
  });

  it("leaves an uncapped export input unchanged", async () => {
    const event = { type: CLI_EVENT_TYPES.TEXT, data: { text: "unchanged" } };
    const output = {
      prompt: "prompt",
      response: "response",
      elapsed: 1,
      isStreaming: false,
      structured: { events: [event], metadata: {} as never },
    };
    const fetchEvent = vi.fn();
    const address = {
      workflowKey: "workflow-a" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const result = await hydrateOrderedCliEntries(
      [
        {
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          timestampMs: 1,
          sequence: 1,
          attemptIndex: 0,
          cliOutput: output,
        },
      ],
      address,
      fetchEvent
    );
    expect(result[0]?.kind).toBe(OUTPUT_HISTORY_KINDS.CLI);
    if (result[0]?.kind === OUTPUT_HISTORY_KINDS.CLI) {
      expect(result[0].cliOutput).toBe(output);
    }
    expect(fetchEvent).not.toHaveBeenCalled();
  });

  it("copies full output after fetching a capped event", async () => {
    const message: OutputMessage = {
      type: "cli",
      target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
      timestamp: 1,
      attemptIndex: 2,
      runIndex: 3,
      data: {
        prompt: "prompt",
        response: "",
        elapsed: 1,
        isStreaming: false,
        structured: {
          events: [
            {
              type: CLI_EVENT_TYPES.TEXT,
              data: { text: "head" },
              outputTruncated: true,
              outputTotalBytes: 14,
            },
          ],
          metadata: {} as never,
        },
      },
    };
    const address = {
      workflowKey: "workflow-a" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const fetchEvent = vi.fn().mockResolvedValue({
      type: CLI_EVENT_TYPES.TEXT,
      data: { text: "complete output" },
    });
    const fullMessages = await hydrateOutputMessages(
      [message],
      address,
      fetchEvent
    );
    const copied = buildCopyAllText(
      fullMessages,
      new Map([["queue:0", 0]]),
      []
    );

    expect(copied).toContain("complete output");
    expect(copied).not.toContain("head");
  });

  it("uses aggregate event indices when hydrating activity slices", async () => {
    const address = {
      workflowKey: "workflow-a" as WorkflowKey,
      runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
    };
    const message: OutputMessage = {
      type: "cli",
      target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
      timestamp: 1,
      attemptIndex: 0,
      activityEventIndices: [4, 9],
      data: {
        prompt: "prompt",
        response: "",
        elapsed: 1,
        isStreaming: false,
        structured: {
          events: [
            {
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              data: {
                command: "cmd",
                output: "head 4",
                outputTruncated: true,
              },
            },
            {
              type: CLI_EVENT_TYPES.TOOL_RESULT,
              data: {
                toolCallId: "call-9",
                result: {
                  success: true,
                  output: "head 9",
                  outputTruncated: true,
                },
              },
            },
          ],
          metadata: {} as never,
        },
      },
    };
    const fetchEvent = Object.assign(vi.fn(), {
      requestMany: vi.fn().mockResolvedValue([
        { type: CLI_EVENT_TYPES.BASH_COMMAND, data: { output: "full 4" } },
        {
          type: CLI_EVENT_TYPES.TOOL_RESULT,
          data: { result: { output: "full 9" } },
        },
      ]),
    });

    const [hydrated] = await hydrateOutputMessages(
      [message],
      address,
      fetchEvent
    );

    expect(fetchEvent.requestMany).toHaveBeenCalledWith([
      expect.objectContaining({ eventIndex: 4 }),
      expect.objectContaining({ eventIndex: 9 }),
    ]);
    expect(
      (hydrated.data as { structured: { events: Array<{ data: unknown }> } })
        .structured.events
    ).toEqual([
      { type: CLI_EVENT_TYPES.BASH_COMMAND, data: { output: "full 4" } },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        data: { result: { output: "full 9" } },
      },
    ]);
  });
});
