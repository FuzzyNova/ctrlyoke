import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useOutputContextMenu } from "@hooks/useOutputContextMenu";
import type { OutputMessage } from "@utils/outputProjection";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { OUTPUT_MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { WorkflowStep } from "@store/workflowStore";

function makeCliMessage(
  index: number,
  response: string,
  timestamp: number,
  extra: { prompt?: string; cliCommand?: string } = {}
): OutputMessage {
  return {
    type: OUTPUT_MESSAGE_TYPES.CLI,
    target: { kind: FINAL_STEP_PHASES.QUEUE, index },
    timestamp,
    prompt: extra.prompt,
    data: {
      structured: {
        events: [{ type: "text", data: { text: response } }],
        metadata: {},
      },
      elapsed: 1,
      isStreaming: false,
      cliCommand: extra.cliCommand,
    },
  };
}

const messages = [
  makeCliMessage(0, "visible output one", 1),
  makeCliMessage(1, "hidden output two", 2),
  makeCliMessage(2, "visible output three", 3),
];

function TestHarness({
  allMessages = messages,
  hiddenTargetKeys = ["queue:1"],
  steps = [],
}: {
  allMessages?: OutputMessage[];
  hiddenTargetKeys?: string[];
  steps?: WorkflowStep[];
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastCliIndexPerStep = new Map(
    allMessages.map((message, index) => [
      `${message.target.kind}:${message.target.index}`,
      index,
    ])
  );
  const { openContextMenu, outputContextMenuPortal } = useOutputContextMenu({
    allMessages,
    hiddenTargetKeys,
    stepScrollFractions: new Map(
      allMessages.map((message, index) => [
        `${message.target.kind}:${message.target.index}`,
        index / Math.max(1, allMessages.length),
      ])
    ),
    lastCliIndexPerStep,
    steps,
    finalStep: null,
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

  it("labels filtered Copy All Responses with the hidden step count and copies visible output only", () => {
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const copyAll = screen.getByRole("menuitem", {
      name: "Copy All Responses (1 step hidden)",
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

  it("copies assistant text and the full single-step export from the hovered step", () => {
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy Step Response" })
    );
    expect(writeText).toHaveBeenLastCalledWith("visible output one");

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy Step Transcript" })
    );
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining("visible output one")
    );
  });

  it("keeps the original step number when a middle step has no CLI output", () => {
    render(
      <TestHarness
        allMessages={[
          makeCliMessage(0, "output one", 1),
          makeCliMessage(2, "output three", 2),
        ]}
        hiddenTargetKeys={[]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy All Responses" })
    );

    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("=== Step 1 ===");
    expect(copiedText).toContain("=== Step 3 ===");
    expect(copiedText).not.toContain("=== Step 2 ===");
  });

  it("copies each step's sent prompt, not the harness command line", () => {
    render(
      <TestHarness
        allMessages={[
          makeCliMessage(0, "output one", 1, {
            prompt: "Fix the parser",
            cliCommand: "claude -p --model opus",
          }),
        ]}
        hiddenTargetKeys={[]}
        steps={[
          { prompt: "Fix the parser", name: "Parser fix" } as WorkflowStep,
        ]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy All Responses" })
    );

    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("=== Step 1: Parser fix ===");
    expect(copiedText).toContain("Prompt:\nFix the parser");
    expect(copiedText).toContain("Response:\noutput one");
    expect(copiedText).not.toContain("claude -p");
  });

  it("explains what each copy item includes in its tooltip", () => {
    render(<TestHarness hiddenTargetKeys={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Copy All Responses" })
    ).toHaveAttribute("title", expect.stringContaining("prompt"));
    expect(
      screen.getByRole("menuitem", { name: "Copy Step Transcript" })
    ).toHaveAttribute("title", expect.stringContaining("tool calls"));
  });

  it("keeps real step numbers when output arrives out of order", () => {
    render(
      <TestHarness
        allMessages={[
          makeCliMessage(2, "output three", 1),
          makeCliMessage(1, "output two", 2),
        ]}
        hiddenTargetKeys={[]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy All Responses" })
    );

    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toMatch(
      /=== Step 3 ===[\s\S]*output three[\s\S]*=== Step 2 ===[\s\S]*output two/
    );
  });
});
