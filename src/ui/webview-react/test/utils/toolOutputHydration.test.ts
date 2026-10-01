import { describe, expect, it, vi } from "vitest";
import { CLI_EVENT_TYPES, FINAL_STEP_PHASES, OUTPUT_HISTORY_KINDS } from "@root/types/DashboardConstants";
import type { OrderedCliHistoryEntry } from "@root/types/OutputHistoryTypes";
import { generateMarkdownExport } from "@utils/markdownExport";
import { hydrateOrderedCliEntries, hydrateOutputMessages } from "@utils/toolOutputHydration";
import { buildCopyAllText } from "@hooks/useOutputContextMenu";
import type { OutputMessage } from "@utils/outputProjection";
import { capToolOutputEvent } from "@root/utils/ToolOutputPayload";
import { buildCollapsedOutputPreview } from "@utils/outputTruncation";
import type { WorkflowKey, RunRef } from "@root/types/CtrlYokeTypes";

describe("tool output export hydration", () => {
  it("keeps the collapsed preview identical to the uncapped output", () => {
    const output = `${"first line\nsecond line\nthird line\n"}${"x".repeat(450_000)}`;
    const event = capToolOutputEvent({
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      data: { command: "cmd", output },
    });
    const capped = (event.data as { output: string }).output;
    const options = { expanded: false, maxLines: 3, maxChars: 100_000 };
    expect(buildCollapsedOutputPreview(output, options)).toEqual(
      buildCollapsedOutputPreview(capped, options)
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
    const hydrated = await hydrateOrderedCliEntries([entry], address, fetchEvent);
    const markdown = generateMarkdownExport(
      [],
      { fileName: "workflow", executionState: "completed", currentStep: 1, totalSteps: 1 },
      { orderedEntries: hydrated, exportOptions: { includeCommand: true, includeMetadata: true } }
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
    const render = (entries: typeof result) =>
      generateMarkdownExport(
        [],
        { fileName: "workflow", executionState: "completed", currentStep: 1, totalSteps: 1 },
        { orderedEntries: entries, exportOptions: { includeCommand: true, includeMetadata: true } }
      );
    expect(result[0]?.kind).toBe(OUTPUT_HISTORY_KINDS.CLI);
    if (result[0]?.kind === OUTPUT_HISTORY_KINDS.CLI) {
      expect(result[0].cliOutput).toBe(output);
    }
    expect(fetchEvent).not.toHaveBeenCalled();
    expect(render(result)).toBe(
      render([
        {
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          timestampMs: 1,
          sequence: 1,
          attemptIndex: 0,
          cliOutput: output,
        },
      ])
    );
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
    const copied = buildCopyAllText(fullMessages, new Map([["queue:0", 0]]), []);

    expect(copied).toContain("complete output");
    expect(copied).not.toContain("head");
  });
});
