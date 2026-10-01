import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useOutputContextMenu } from "@hooks/useOutputContextMenu";
import type { OutputMessage } from "@utils/outputProjection";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { OUTPUT_MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { CLI_EVENT_TYPES, MESSAGE_TYPES } from "@/types/messages";

function makeCliMessage(
  index: number,
  response: string,
  timestamp: number
): OutputMessage {
  return {
    type: OUTPUT_MESSAGE_TYPES.CLI,
    target: { kind: FINAL_STEP_PHASES.QUEUE, index },
    timestamp,
    data: {
      prompt: `prompt ${index + 1}`,
      response,
      elapsed: 1,
      isStreaming: false,
    },
  };
}

const messages = [
  makeCliMessage(0, "visible output one", 1),
  makeCliMessage(1, "hidden output two", 2),
  makeCliMessage(2, "visible output three", 3),
];

function TestHarness({
  allMessages: messagesForMenu = messages,
  withAddress = false,
}: {
  allMessages?: OutputMessage[];
  withAddress?: boolean;
} = {}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { openContextMenu, outputContextMenuPortal } = useOutputContextMenu({
    allMessages: messagesForMenu,
    ...(withAddress
      ? {
          address: {
            workflowKey: "workflow-a" as never,
            runRef: "run-2026-10-01T00-00-00-000Z" as never,
          },
        }
      : {}),
    hiddenTargetKeys: ["queue:1"],
    stepScrollFractions: new Map([
      ["queue:0", 0],
      ["queue:1", 0.5],
      ["queue:2", 0.75],
    ]),
    lastCliIndexPerStep: new Map([
      ["queue:0", 0],
      ["queue:1", 1],
      ["queue:2", 2],
    ]),
    onOpenFind: vi.fn(),
  });

  return (
    <>
      <div ref={scrollContainerRef}>
        <button
          onClick={() => openContextMenu(20, 20, scrollContainerRef.current!)}
        >
          Open menu
        </button>
      </div>
      {outputContextMenuPortal}
    </>
  );
}

describe("useOutputContextMenu", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("labels filtered Copy All with the hidden step count and copies visible output only", () => {
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const copyAll = screen.getByRole("button", {
      name: "Copy All (1 step hidden)",
    });
    expect(copyAll).toBeInTheDocument();

    fireEvent.click(copyAll);

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("visible output one")
    );
    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("visible output three");
    expect(copiedText).not.toContain("hidden output two");
    expect(copiedText).toContain("=== Step 3 ===");
  });

  it("fetches a capped event before copying hovered step output", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const cappedMessage: OutputMessage = {
      type: OUTPUT_MESSAGE_TYPES.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
      timestamp: 1,
      attemptIndex: 2,
      runIndex: 3,
      data: {
        prompt: "prompt",
        response: "head only",
        elapsed: 1,
        isStreaming: false,
        structured: {
          events: [
            {
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              data: {
                command: "cat log",
                output: "head only",
                outputTruncated: true,
                outputTotalBytes: 400_000,
              },
              outputTruncated: true,
              outputTotalBytes: 400_000,
            },
          ],
          metadata: {},
        },
      },
    };
    vi.spyOn(window.vscodeApi!, "postMessage").mockImplementation(
      (request: any) => {
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
                    data: { command: "cat log", output: "complete output" },
                  },
                })),
              },
            })
          );
        }, 0);
      }
    );
    render(<TestHarness allMessages={[cappedMessage]} withAddress />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Step Output" }));

    await waitFor(() => {
      expect(window.vscodeApi!.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MESSAGE_TYPES.REQUEST_TOOL_OUTPUT_CONTENT,
          events: expect.arrayContaining([
            expect.objectContaining({
              attemptIndex: 2,
              runIndex: 3,
              eventIndex: 0,
            }),
          ]),
        })
      );
    });
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("head only")
    );
  });
});
