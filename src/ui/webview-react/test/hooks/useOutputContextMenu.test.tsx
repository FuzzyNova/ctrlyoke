import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useOutputContextMenu } from "@hooks/useOutputContextMenu";
import type { OutputMessage } from "@utils/outputProjection";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { OUTPUT_MESSAGE_TYPES } from "@root/types/DashboardConstants";

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

function TestHarness() {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { openContextMenu, outputContextMenuPortal } = useOutputContextMenu({
    allMessages: messages,
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
});
